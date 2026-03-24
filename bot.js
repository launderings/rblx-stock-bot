require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const express = require("express");
const fetch   = require("node-fetch");
const crypto  = require("crypto");

const DISCORD_TOKEN         = process.env.DISCORD_TOKEN;
const BRIDGE_PORT           = process.env.PORT || 3000;
const ROBLOX_OPEN_CLOUD_KEY = process.env.ROBLOX_OPEN_CLOUD_KEY;
const ROBLOX_UNIVERSE_ID    = process.env.ROBLOX_UNIVERSE_ID;
const ROBLOX_DATASTORE_NAME = "StockCommands_v1";
const ALLOWED_GUILD_ID      = process.env.GUILD_ID;
const ADMIN_ROLE_ID         = process.env.ADMIN_ROLE_ID;

// ── Roblox Open Cloud helpers ─────────────────────────────────
async function dsRequest(method, dsName, entryKey, body) {
    const universe = ROBLOX_UNIVERSE_ID;
    const ds  = encodeURIComponent(dsName);
    const key = encodeURIComponent(entryKey);
    const base = `https://apis.roblox.com/cloud/v2/universes/${universe}/data-stores/${ds}/entries`;

    if (method === "GET") {
        const res = await fetch(`${base}/${key}`, {
            method: "GET",
            headers: { "x-api-key": ROBLOX_OPEN_CLOUD_KEY },
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`Roblox GET error ${res.status}: ${await res.text()}`);
        const text = await res.text();
        // v2 API returns JSON with a "value" field containing the stored string
        try {
            const outer = JSON.parse(text);
            // value field contains the actual data as a JSON string
            if (outer.value !== undefined) {
                try { return JSON.parse(outer.value); } catch { return outer.value; }
            }
            return outer;
        } catch {
            return text;
        }
    }

    if (method === "DEL") {
        const res = await fetch(`${base}/${key}`, {
            method: "DELETE",
            headers: { "x-api-key": ROBLOX_OPEN_CLOUD_KEY },
        });
        return res.ok;
    }

    // PATCH/POST — wrap value as JSON string
    const payload = JSON.stringify({ value: JSON.stringify(body) });
    let res = await fetch(`${base}/${key}`, {
        method: "PATCH",
        headers: { "x-api-key": ROBLOX_OPEN_CLOUD_KEY, "content-type": "application/json" },
        body: payload,
    });
    if (res.status === 404) {
        res = await fetch(`${base}?id=${key}`, {
            method: "POST",
            headers: { "x-api-key": ROBLOX_OPEN_CLOUD_KEY, "content-type": "application/json" },
            body: payload,
        });
    }
    if (!res.ok) throw new Error(`Roblox ${method} error ${res.status}: ${await res.text()}`);
    return body;
}

async function pushCommandToRoblox(command) {
    return dsRequest("SET", ROBLOX_DATASTORE_NAME, "PendingCommand", command);
}

// ── Roblox API helpers ────────────────────────────────────────
async function getRobloxUserId(username) {
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
    });
    const data = await res.json();
    if (data.data && data.data.length > 0) return data.data[0].id;
    return null;
}

async function getRobloxUsername(userId) {
    const res = await fetch(`https://users.roblox.com/v1/users/${userId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.name;
}

// Pending link codes: { discordId -> { code, username, expires } }
const pendingLinks = new Map();

// ── Discord bot ───────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates] });

client.once("ready", async () => {
    console.log(`[Bot] Logged in as ${client.user.tag}`);
    setInterval(pollLinkVerifications, 5000);
    for (const guild of client.guilds.cache.values()) {
        await ensurePersistentPanel(guild).catch(console.error);
        await ensureTicketPanel(guild).catch(console.error);
    }
});

// Prevent unhandled errors from crashing the bot
process.on("unhandledRejection", (err) => {
    console.error("[Bot] Unhandled rejection:", err.message);
});

// Auto-react to messages in polls channel
const POLLS_CHANNEL_ID = process.env.POLLS_CHANNEL_ID;
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!POLLS_CHANNEL_ID || message.channelId !== POLLS_CHANNEL_ID) return;
    try {
        await message.react("⬆️");
        await message.react("⬇️");
    } catch (err) {
        console.error("[Polls] Failed to react:", err.message);
    }
});

// ================================================================
// JOIN TO CREATE VC — Persistent VoiceMaster Panel
// ================================================================
const JTC_CHANNEL_ID      = process.env.JTC_CHANNEL_ID;
const JTC_TEXT_CHANNEL_ID = process.env.JTC_TEXT_CHANNEL_ID;
const tempChannels = new Map(); // voiceChannelId -> { ownerId }
let persistentPanelMsgId  = null; // ID of the single persistent control panel message

// Persistent panel — buttons always use fixed IDs, action resolves VC from user's current channel
function buildVCPanel() {
    const embed = new EmbedBuilder()
        .setAuthor({ name: "VoiceMaster Interface" })
        .setDescription("Click the buttons below to control **your** voice channel")
        .addFields({ name: "Button Usage", value: [
            "🔒 — **Lock** the voice channel",
            "🔓 — **Unlock** the voice channel",
            "👻 — **Ghost** the voice channel",
            "👁️ — **Reveal** the voice channel",
            "🎙️ — **Claim** the voice channel",
            "🔨 — **Disconnect** a member",
            "🎮 — **Start** an activity",
            "📋 — **View** channel information",
            "➕ — **Increase** the user limit",
            "➖ — **Decrease** the user limit",
        ].join("\n") })
        .setColor(0x5865f2);

    const row1 = {
        type: 1, components: [
            { type: 2, style: 2, emoji: "🔒", custom_id: "vc_lock" },
            { type: 2, style: 2, emoji: "🔓", custom_id: "vc_unlock" },
            { type: 2, style: 2, emoji: "👻", custom_id: "vc_ghost" },
            { type: 2, style: 2, emoji: "👁️", custom_id: "vc_reveal" },
            { type: 2, style: 2, emoji: "🎙️", custom_id: "vc_claim" },
        ]
    };
    const row2 = {
        type: 1, components: [
            { type: 2, style: 2, emoji: "🔨", custom_id: "vc_kick" },
            { type: 2, style: 2, emoji: "🎮", custom_id: "vc_activity" },
            { type: 2, style: 2, emoji: "📋", custom_id: "vc_info" },
            { type: 2, style: 2, emoji: "➕", custom_id: "vc_increase" },
            { type: 2, style: 2, emoji: "➖", custom_id: "vc_decrease" },
        ]
    };


    return { embeds: [embed], components: [row1, row2] };
}

// Post or restore the persistent panel on bot ready
async function ensurePersistentPanel(guild) {
    if (!JTC_TEXT_CHANNEL_ID) return;
    const textChannel = guild.channels.cache.get(JTC_TEXT_CHANNEL_ID);
    if (!textChannel) return;

    // Check if panel already exists in last 50 messages
    const messages = await textChannel.messages.fetch({ limit: 50 });
    const existing = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0].author?.name === "VoiceMaster Interface");

    if (existing) {
        persistentPanelMsgId = existing.id;
        console.log("[JTC] Found existing persistent panel");
    } else {
        const msg = await textChannel.send(buildVCPanel());
        persistentPanelMsgId = msg.id;
        console.log("[JTC] Posted new persistent panel");
    }
}

client.on("voiceStateUpdate", async (oldState, newState) => {
    // User joined the JTC channel
    if (newState.channelId === JTC_CHANNEL_ID && JTC_CHANNEL_ID) {
        try {
            const member = newState.member;
            const guild  = newState.guild;
            const parent = newState.channel.parentId;

            const newChannel = await guild.channels.create({
                name: `${member.displayName}'s VC`,
                type: 2,
                parent: parent,
                permissionOverwrites: [
                    { id: guild.id, deny: [] },
                    { id: member.id, allow: ["ManageChannels", "MoveMembers", "MuteMembers", "DeafenMembers"] },
                ],
            });

            await member.voice.setChannel(newChannel);
            tempChannels.set(newChannel.id, { ownerId: member.id });
            console.log(`[JTC] Created ${newChannel.name} for ${member.displayName}`);
        } catch (err) {
            console.error(`[JTC] Error creating channel: ${err.message}`);
        }
    }

    // User left a temp channel — delete it if empty
    if (oldState.channelId && tempChannels.has(oldState.channelId)) {
        const channel = oldState.guild.channels.cache.get(oldState.channelId);
        if (channel && channel.members.size === 0) {
            try {
                await channel.delete();
                tempChannels.delete(oldState.channelId);
                console.log(`[JTC] Deleted empty channel: ${channel.name}`);
            } catch (err) {
                console.error(`[JTC] Error deleting channel: ${err.message}`);
            }
        }
    }
});

// Handle VC control button interactions
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    const [prefix, action] = interaction.customId.split("_");
    if (prefix !== "vc") return;

    const guild  = interaction.guild;
    const member = interaction.member;

    // Resolve the user's current voice channel
    const voiceState = member.voice;
    const channel    = voiceState?.channel;
    const channelId  = channel?.id;
    const data       = channelId ? tempChannels.get(channelId) : null;

    if (!channel || !data) return interaction.reply({ content: "You need to be in a voice channel created by the bot.", ephemeral: true });

    const isOwner = data.ownerId === member.id;
    const isAdmin = ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID);

    if (action === "info") {
        const members = channel.members.map(m => m.displayName).join(", ") || "Empty";
        return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder()
            .setTitle(`📋 ${channel.name}`)
            .addFields(
                { name: "Owner", value: data ? `<@${data.ownerId}>` : "Unknown", inline: true },
                { name: "Members", value: members, inline: true },
                { name: "User Limit", value: channel.userLimit === 0 ? "Unlimited" : String(channel.userLimit), inline: true },
            ).setColor(0x5865f2)] });
    }

    if (action === "claim") {
        if (data && guild.members.cache.get(data.ownerId)?.voice?.channelId !== channelId) {
            tempChannels.set(channelId, { ...data, ownerId: member.id });
            await channel.permissionOverwrites.edit(member.id, { ManageChannels: true, MoveMembers: true });
            return interaction.reply({ ephemeral: true, content: "✅ You've claimed this voice channel!" });
        }
        return interaction.reply({ ephemeral: true, content: "The owner is still in the channel." });
    }

    if (!isOwner && !isAdmin) {
        return interaction.reply({ ephemeral: true, content: "Only the channel owner can use these controls." });
    }

    try {
        if (action === "lock") {
            await channel.permissionOverwrites.edit(guild.id, { Connect: false });
            interaction.reply({ ephemeral: true, content: "🔒 Channel locked." });
        } else if (action === "unlock") {
            await channel.permissionOverwrites.edit(guild.id, { Connect: true });
            interaction.reply({ ephemeral: true, content: "🔓 Channel unlocked." });
        } else if (action === "ghost") {
            await channel.permissionOverwrites.edit(guild.id, { ViewChannel: false });
            interaction.reply({ ephemeral: true, content: "👻 Channel hidden." });
        } else if (action === "reveal") {
            await channel.permissionOverwrites.edit(guild.id, { ViewChannel: true });
            interaction.reply({ ephemeral: true, content: "👁️ Channel revealed." });
        } else if (action === "increase") {
            const newLimit = Math.min((channel.userLimit || 0) + 1, 99);
            await channel.setUserLimit(newLimit);
            interaction.reply({ ephemeral: true, content: `➕ User limit set to **${newLimit}**.` });
        } else if (action === "decrease") {
            const newLimit = Math.max((channel.userLimit || 1) - 1, 0);
            await channel.setUserLimit(newLimit);
            interaction.reply({ ephemeral: true, content: `➖ User limit set to **${newLimit === 0 ? "unlimited" : newLimit}**.` });
        } else if (action === "kick") {
            const vcMembers = channel.members.filter(m => m.id !== member.id);
            if (vcMembers.size === 0) return interaction.reply({ ephemeral: true, content: "No other members in the channel." });
            const options = vcMembers.map(m => ({ label: m.displayName, value: m.id })).slice(0, 25);
            await interaction.reply({ ephemeral: true, components: [{
                type: 1, components: [{
                    type: 3, custom_id: "vc_kickselect",
                    placeholder: "Select a member to disconnect",
                    options
                }]
            }]});
        } else if (action === "activity") {
            interaction.reply({ ephemeral: true, content: "🎮 To start an activity, right-click the voice channel → Activities." });
        }
    } catch (err) {
        interaction.reply({ ephemeral: true, content: `Error: ${err.message}` }).catch(() => {});
    }
});

// Handle kick select menu
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    const [prefix, action] = interaction.customId.split("_");
    if (prefix !== "vc" || action !== "kickselect") return;

    const guild   = interaction.guild;
    const member2 = interaction.member;
    const channel = member2.voice?.channel;
    if (!channel) return interaction.reply({ content: "You are not in a voice channel.", ephemeral: true });

    const targetId = interaction.values[0];
    const target   = guild.members.cache.get(targetId);
    if (target?.voice?.channelId === channelId) {
        await target.voice.disconnect();
        interaction.reply({ ephemeral: true, content: `🔨 Disconnected **${target.displayName}**.` });
    } else {
        interaction.reply({ ephemeral: true, content: "That member is no longer in the channel." });
    }
});

// Auto-role new members
const AUTO_ROLE_ID = "1483427463504724039";
client.on("guildMemberAdd", async (member) => {
    try {
        const role = member.guild.roles.cache.get(AUTO_ROLE_ID);
        if (role) {
            await member.roles.add(role);
            console.log(`[AutoRole] Gave ${member.user.tag} the Players role`);
        } else {
            console.warn(`[AutoRole] Role ${AUTO_ROLE_ID} not found in guild`);
        }
    } catch (err) {
        console.error(`[AutoRole] Failed to add role: ${err.message}`);
    }
});

async function pollLinkVerifications() {
    if (pendingLinks.size === 0) return;
    const now = Date.now();
    for (const [discordId, pending] of pendingLinks) {
        // Check if expired
        if (now > pending.expires) {
            pendingLinks.delete(discordId);
            continue;
        }
        try {
            // Check if Roblox game has submitted a verification
            const result = await dsRequest("GET", "StockLinks_v1", `verify_${pending.code}`);
            if (result && result.robloxUserId) {
                // Link confirmed — save Discord -> Roblox mapping
                await dsRequest("SET", "StockLinks_v1", `discord_${discordId}`, {
                    robloxUserId: result.robloxUserId,
                    robloxUsername: result.robloxUsername,
                    linkedAt: Date.now(),
                });
                // Clean up verification entry
                try { await dsRequest("DEL", "StockLinks_v1", `verify_${pending.code}`); } catch {}
                pendingLinks.delete(discordId);
                // Notify user in Discord
                try {
                    const user = await client.users.fetch(discordId);
                    await user.send({
                        embeds: [new EmbedBuilder()
                            .setTitle("✅ Account Linked!")
                            .setDescription(`Your Discord is now linked to **${result.robloxUsername}** on Roblox.\nYou can now use /balance, /portfolio, and /richlist.`)
                            .setColor(0x26a69a)
                            .setTimestamp()]
                    });
                } catch {}
            }
        } catch {}
    }
}

async function getLinkedRobloxId(discordId) {
    const link = await dsRequest("GET", "StockLinks_v1", `discord_${discordId}`);
    return link;
}

async function getPlayerData(robloxUserId) {
    return dsRequest("GET", "StockGame_v1", String(robloxUserId));
}

function formatDollar(n) {
    if (!n && n !== 0) return "$0.00";
    return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isAdmin(interaction) {
    if (!ADMIN_ROLE_ID) return true;
    return interaction.member.roles.cache.has(ADMIN_ROLE_ID);
}

function embed(title, desc, color) {
    return new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setTimestamp().setFooter({ text: "RBLX Stock Market" });
}

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (ALLOWED_GUILD_ID && interaction.guildId !== ALLOWED_GUILD_ID) return;

    const cmd = interaction.commandName;

    // ── Economy commands (no admin required) ─────────────────
    if (cmd === "whitelist") {
        await interaction.deferReply({ ephemeral: true });
        const target  = interaction.options.getUser("member");
        const member  = interaction.member;
        const channel = member.voice?.channel;
        const data    = channel ? tempChannels.get(channel.id) : null;
        if (!channel || !data) return interaction.editReply("You need to be in a bot-created voice channel.");
        if (data.ownerId !== member.id) return interaction.editReply("Only the channel owner can whitelist members.");
        await channel.permissionOverwrites.edit(target.id, { Connect: true, ViewChannel: true });
        await interaction.editReply(`✅ **${target.username}** can now join your voice channel.`);
        return;
    }

    if (cmd === "unwhitelist") {
        await interaction.deferReply({ ephemeral: true });
        const target  = interaction.options.getUser("member");
        const member  = interaction.member;
        const channel = member.voice?.channel;
        const data    = channel ? tempChannels.get(channel.id) : null;
        if (!channel || !data) return interaction.editReply("You need to be in a bot-created voice channel.");
        if (data.ownerId !== member.id) return interaction.editReply("Only the channel owner can unwhitelist members.");
        await channel.permissionOverwrites.delete(target.id);
        await interaction.editReply(`❌ **${target.username}** has been removed from your whitelist.`);
        return;
    }

    if (cmd === "blackjack" || cmd === "bj") {
        await interaction.deferReply();
        try {
            const bet = interaction.options.getNumber("bet");
            const link = await getLinkedRobloxId(interaction.user.id);
            if (!link) return interaction.editReply({ embeds: [embed("Not Linked", "Link your account first with `/link`.", 0xff4444)] });
            const data = await getPlayerData(link.robloxUserId);
            if (!data) return interaction.editReply({ embeds: [embed("No Data", "No game data found.", 0xff4444)] });
            if (bet > data.balance) return interaction.editReply({ embeds: [embed("Insufficient Funds", `You only have ${formatDollar(data.balance)}.`, 0xff4444)] });
            if (bet < 1) return interaction.editReply({ embeds: [embed("Invalid Bet", "Minimum bet is $1.", 0xff4444)] });

            // Deal cards
            const deck = newDeck();
            const playerHand = [deck.pop(), deck.pop()];
            const dealerHand = [deck.pop(), deck.pop()];
            let balance = data.balance - bet;

            // Check natural blackjack
            if (handValue(playerHand) === 21) {
                const payout = Math.floor(bet * 2.5); // BJ pays 3:2
                balance += payout;
                await updateBalance(link.robloxUserId, balance);
                return interaction.editReply({ embeds: [bjEmbed(playerHand, dealerHand, bet, balance, "bj", false)] });
            }

            // Save game state
            const msg = await interaction.editReply({
                embeds: [bjEmbed(playerHand, dealerHand, bet, balance + bet, "playing", true)],
                components: [{
                    type: 1,
                    components: [
                        { type: 2, style: 1, label: "Hit", custom_id: "bj_hit" },
                        { type: 2, style: 4, label: "Stand", custom_id: "bj_stand" },
                        { type: 2, style: 2, label: "Double Down", custom_id: "bj_double" },
                    ]
                }]
            });

            const timeoutId = setTimeout(() => activeGames.delete(msg.id), 5 * 60 * 1000);
            activeGames.set(msg.id, {
                deck, playerHand, dealerHand, bet,
                discordId: interaction.user.id,
                robloxId: link.robloxUserId,
                balance,
                originalBalance: data.balance,
                timeoutId,
            });

        } catch (err) { await interaction.editReply(`Error: ${err.message}`); }
        return;
    }

    if (cmd === "link") {
        await interaction.deferReply({ ephemeral: true });
        try {
            // Generate a 6-digit code
            const code = Math.floor(100000 + Math.random() * 900000).toString();
            pendingLinks.set(interaction.user.id, {
                code,
                expires: Date.now() + 5 * 60 * 1000, // 5 min expiry
            });
            // Write code to DataStore so game can find it
            await dsRequest("SET", "StockLinks_v1", `code_${code}`, {
                discordId: interaction.user.id,
                expires: Date.now() + 5 * 60 * 1000,
            });
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle("🔗 Link Your Account")
                    .setDescription(
                        `Your verification code is:\n\n` +
                        `## \`${code}\`\n\n` +
                        `1. Open the stock market in Roblox\n` +
                        `2. Click **Link Account** in the chart window\n` +
                        `3. Enter the code above\n\n` +
                        `*Code expires in 5 minutes*`
                    )
                    .setColor(0x2962ff)
                    .setTimestamp()]
            });
        } catch (err) {
            await interaction.editReply(`Error: ${err.message}`);
        }
        return;
    }

    if (cmd === "marketstatus") {
        await interaction.deferReply();
        try {
            // Read latest candle data from DataStore
            const data = await dsRequest("GET", "StockMarket_v6", "MarketStateV2");
            if (!data || !data.markets) {
                return interaction.editReply({ embeds: [embed("Market Status", "No market data available yet.", 0x787b86)] });
            }
            const sectors = {
                "Tech / Quant":        ["NRMT","ALGF","QNTG","BYTV"],
                "Energy":              ["VLTA","APXF","GRDF","HLCR"],
                "Defense / Industrial":["IRCD","SNTL","TTWK","AEGM"],
                "Finance":             ["CRPT","BLDG","NBMK","PMYD"],
                "Legacy":              ["NXCR","VLTX","PLHR"],
            };
            const fields = [];
            for (const [sector, symbols] of Object.entries(sectors)) {
                let lines = "";
                for (const sym of symbols) {
                    const market = data.markets[sym];
                    if (!market || !market.candles || market.candles.length === 0) continue;
                    const candles = market.candles;
                    const last  = candles[candles.length - 1];
                    const first = candles[0];
                    const chg   = last.close - first.open;
                    const chgPct = ((chg / first.open) * 100).toFixed(2);
                    const arrow = chg >= 0 ? "🟢" : "🔴";
                    const sign  = chg >= 0 ? "+" : "";
                    lines += `${arrow} **${sym}** $${last.close.toFixed(2)}  ${sign}${chgPct}%
`;
                }
                if (lines) fields.push({ name: sector, value: lines, inline: false });
            }
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle("📊 Market Status — All 19 Stocks")
                    .addFields(...fields)
                    .setColor(0x2962ff)
                    .setTimestamp()
                    .setFooter({ text: "RBLX Stock Market" })]
            });
        } catch (err) { await interaction.editReply(`Error: ${err.message}`); }
        return;
    }

    if (cmd === "balance") {
        await interaction.deferReply();
        try {
            const link = await getLinkedRobloxId(interaction.user.id);
            if (!link) {
                return interaction.editReply({ embeds: [embed("Not Linked", "Link your account first with `/link`.", 0xff4444)] });
            }
            const data = await getPlayerData(link.robloxUserId);
            if (!data) {
                return interaction.editReply({ embeds: [embed("No Data", "No game data found for your account.", 0xff4444)] });
            }
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle(`💰 ${link.robloxUsername}'s Balance`)
                    .setDescription(`**Cash:** ${formatDollar(data.balance)}`)
                    .setColor(0xf5a623)
                    .setTimestamp()
                    .setFooter({ text: "RBLX Stock Market" })]
            });
        } catch (err) {
            await interaction.editReply(`Error: ${err.message}`);
        }
        return;
    }

    if (cmd === "portfolio") {
        await interaction.deferReply();
        try {
            const link = await getLinkedRobloxId(interaction.user.id);
            if (!link) {
                return interaction.editReply({ embeds: [embed("Not Linked", "Link your account first with `/link`.", 0xff4444)] });
            }
            const data = await getPlayerData(link.robloxUserId);
            if (!data) {
                return interaction.editReply({ embeds: [embed("No Data", "No game data found.", 0xff4444)] });
            }
            const shares = data.shares || {};
            let sharesText = "";
            let totalShares = 0;
            for (const [sym, qty] of Object.entries(shares)) {
                if (qty > 0) {
                    sharesText += `**${sym}:** ${qty} shares\n`;
                    totalShares += qty;
                }
            }
            if (!sharesText) sharesText = "*No shares held*";
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle(`📊 ${link.robloxUsername}'s Portfolio`)
                    .addFields(
                        { name: "💵 Cash Balance", value: formatDollar(data.balance), inline: true },
                        { name: "📈 Total Shares", value: String(totalShares), inline: true },
                        { name: "🏦 Holdings", value: sharesText }
                    )
                    .setColor(0x26a69a)
                    .setTimestamp()
                    .setFooter({ text: "RBLX Stock Market" })]
            });
        } catch (err) {
            await interaction.editReply(`Error: ${err.message}`);
        }
        return;
    }

    if (cmd === "leaderboard") {
        await interaction.deferReply();
        try {
            // Read richlist from DataStore (maintained by Roblox server)
            const list = await dsRequest("GET", "StockGame_v1", "RichList");
            if (!list || !list.entries || list.entries.length === 0) {
                return interaction.editReply({ embeds: [embed("Rich List", "No data yet. Players need to be online for the list to update.", 0x787b86)] });
            }
            let desc = "";
            const medals = ["🥇", "🥈", "🥉"];
            list.entries.forEach((entry, i) => {
                const medal = medals[i] || `**${i+1}.**`;
                desc += `${medal} **${entry.username}** — ${formatDollar(entry.netWorth)}\n`;
            });
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setTitle("🏆 Rich List — Top Players")
                    .setDescription(desc)
                    .setColor(0xf5a623)
                    .setTimestamp()
                    .setFooter({ text: "RBLX Stock Market" })]
            });
        } catch (err) {
            await interaction.editReply(`Error: ${err.message}`);
        }
        return;
    }

    // ── Admin commands ────────────────────────────────────────
    if (!isAdmin(interaction)) {
        return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    await interaction.deferReply();

    try {
        if (cmd === "crash") {
            const severity = interaction.options.getNumber("severity") ?? 0.4;
            const duration = interaction.options.getInteger("duration") ?? 30;
            const reason   = interaction.options.getString("reason") ?? "Market correction";
            const stockC   = interaction.options.getString("stock") || null;
            await pushCommandToRoblox({ type: "CRASH", severity, duration, reason, symbol: stockC, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Market Crash Triggered", `**Severity:** -${Math.round(severity*100)}%\n**Duration:** ${duration}s\n**Reason:** ${reason}`, 0xff4444)] });

        } else if (cmd === "boom") {
            const multiplier = interaction.options.getNumber("multiplier") ?? 1.3;
            const duration   = interaction.options.getInteger("duration") ?? 30;
            const reason     = interaction.options.getString("reason") ?? "Bull run";
            const stockB     = interaction.options.getString("stock") || null;
            await pushCommandToRoblox({ type: "BOOM", multiplier, duration, reason, symbol: stockB, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Market Boom Triggered", `**Surge:** +${Math.round((multiplier-1)*100)}%\n**Duration:** ${duration}s\n**Reason:** ${reason}`, 0x26a69a)] });

        } else if (cmd === "givemoney") {
            const username = interaction.options.getString("username");
            const amount   = interaction.options.getNumber("amount");
            await pushCommandToRoblox({ type: "GIVE_MONEY", username, amount, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Money Given", `**Player:** ${username}\n**Amount:** $${amount.toLocaleString()}`, 0xf5a623)] });

        } else if (cmd === "giveallmoney") {
            const amount = interaction.options.getNumber("amount");
            await pushCommandToRoblox({ type: "GIVE_ALL_MONEY", amount, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Money Given to All", `**Amount per player:** $${amount.toLocaleString()}`, 0xf5a623)] });

        } else if (cmd === "announce") {
            const message  = interaction.options.getString("message");
            const duration = interaction.options.getInteger("duration") ?? 10;
            await pushCommandToRoblox({ type: "ANNOUNCE", message, duration, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Announcement Sent", `**Message:** ${message}`, 0x2962ff)] });

        } else if (cmd === "freeze") {
            const duration = interaction.options.getInteger("duration") ?? 60;
            const stockF   = interaction.options.getString("stock") || null;
            await pushCommandToRoblox({ type: "FREEZE", duration, symbol: stockF, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Market Frozen", `Trading halted for **${duration}s**`, 0x787b86)] });

        } else if (cmd === "unfreeze") {
            await pushCommandToRoblox({ type: "UNFREEZE", issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Market Unfrozen", "Trading resumed.", 0x26a69a)] });

        } else if (cmd === "setregime") {
            const regime = interaction.options.getString("regime");
            const stockR = interaction.options.getString("stock") || null;
            await pushCommandToRoblox({ type: "SET_REGIME", regime, symbol: stockR, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Regime Set", `Market forced into **${regime}** mode`, regime==="BULL" ? 0x26a69a : regime==="BEAR" ? 0xff4444 : 0x787b86)] });

        } else if (cmd === "giftstock") {
            const targetUser = interaction.options.getUser("player");
            const symbol     = interaction.options.getString("stock");
            const qty        = interaction.options.getInteger("amount");

            const targetLink = await getLinkedRobloxId(targetUser.id);
            if (!targetLink) {
                await interaction.editReply({ embeds: [embed("Not Linked", `${targetUser.username} hasn't linked their account yet.`, 0xff4444)] });
            } else {
                const recipientData = await getPlayerData(targetLink.robloxUserId);
                if (!recipientData) {
                    await interaction.editReply({ embeds: [embed("No Data", `${targetUser.username}'s game data not found.`, 0xff4444)] });
                } else {
                    recipientData.shares = recipientData.shares || {};
                    recipientData.shares[symbol] = (recipientData.shares[symbol] || 0) + qty;
                    await dsRequest("SET", "StockGame_v1", String(targetLink.robloxUserId), recipientData);
                    try {
                        await pushCommandToRoblox({ type: "SET_BALANCE", robloxUserId: targetLink.robloxUserId, balance: recipientData.balance, issuedBy: "GiftStock", issuedAt: Date.now() });
                    } catch {}
                    await interaction.editReply({ embeds: [embed("🎁 Shares Gifted!", `Gave **${qty} ${symbol}** to **${targetUser.username}** (${targetLink.robloxUsername})`, 0xf5a623)] });
                    try {
                        await targetUser.send({ embeds: [new EmbedBuilder().setTitle("🎁 You received shares!").setDescription(`An admin gifted you **${qty} ${symbol}** shares!`).setColor(0xf5a623).setTimestamp()] });
                    } catch {}
                }
            }

        } else if (cmd === "datawipe") {
            const username = interaction.options.getString("username") || null;
            const balance  = interaction.options.getNumber("balance") ?? 10000;
            await pushCommandToRoblox({ type: "RESET_DATA", username, balance, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            const who = username ? `**${username}**` : "**all players**";
            await interaction.editReply({ embeds: [embed("Data Reset", `Reset ${who} to $${balance.toLocaleString()}`, 0x787b86)] });

        } else if (cmd === "setprice") {
            const price  = interaction.options.getNumber("price");
            const stockP = interaction.options.getString("stock") || null;
            await pushCommandToRoblox({ type: "SET_PRICE", price, symbol: stockP, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Price Set", `Market price set to **$${price.toLocaleString()}**`, 0xf5a623)] });

        } else if (cmd === "shutdown") {
            const reason = interaction.options.getString("reason") ?? "Server shutdown requested by admin.";
            await pushCommandToRoblox({ type: "SHUTDOWN", reason, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Shutdown Sent", `All servers will shut down.
**Reason:** ${reason}`, 0xff4444)] });

        } else if (cmd === "purge") {
            const amount = interaction.options.getInteger("amount");
            try {
                const deleted = await interaction.channel.bulkDelete(amount, true);
                await interaction.editReply({ content: `🗑️ Deleted **${deleted.size}** message${deleted.size !== 1 ? "s" : ""}.`, ephemeral: true });
            } catch (err) {
                await interaction.editReply({ content: `Error: ${err.message}`, ephemeral: true });
            }
        }

    } catch (err) {
        console.error("[Bot] Error:", err.message);
        await interaction.editReply(`Error: ${err.message}`);
    }
});


// ================================================================
// BLACKJACK
// ================================================================
const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function newDeck() {
    const deck = [];
    for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s });
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function cardValue(card) {
    if (["J","Q","K"].includes(card.rank)) return 10;
    if (card.rank === "A") return 11;
    return parseInt(card.rank);
}

function handValue(hand) {
    let total = hand.reduce((s, c) => s + cardValue(c), 0);
    let aces  = hand.filter(c => c.rank === "A").length;
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
}

function handStr(hand, hideSecond = false) {
    return hand.map((c, i) => (hideSecond && i === 1) ? "🂠" : `${c.rank}${c.suit}`).join("  ");
}

function bjEmbed(playerHand, dealerHand, bet, balance, status, hideDealer = true) {
    const playerVal = handValue(playerHand);
    const dealerVal = hideDealer ? cardValue(dealerHand[0]) : handValue(dealerHand);
    const color = status === "win" ? 0x26a69a : status === "lose" ? 0xff4444 : status === "push" ? 0xf5a623 : 0x2962ff;
    let title = "🃏 Blackjack";
    if (status === "win")  title = "🎉 You Win!";
    if (status === "lose") title = "💀 You Lose!";
    if (status === "push") title = "🤝 Push!";
    if (status === "bj")   title = "🌟 Blackjack! You Win!";
    return new EmbedBuilder()
        .setTitle(title)
        .addFields(
            { name: `Dealer  (${hideDealer ? "?" : dealerVal})`, value: handStr(dealerHand, hideDealer), inline: false },
            { name: `You  (${playerVal})`, value: handStr(playerHand), inline: false },
            { name: "Bet", value: formatDollar(bet), inline: true },
            { name: "Balance", value: formatDollar(balance), inline: true },
        )
        .setColor(color)
        .setFooter({ text: "RBLX Stock Market Blackjack" })
        .setTimestamp();
}

// Active games: { messageId -> { deck, playerHand, dealerHand, bet, discordId, robloxId, balance } }
const activeGames = new Map();

async function updateBalance(robloxUserId, newBalance) {
    console.log(`[BJ] updateBalance called: userId=${robloxUserId} newBalance=${newBalance}`);
    // Read current data
    const data = await dsRequest("GET", "StockGame_v1", String(robloxUserId));
    console.log(`[BJ] current data from DS:`, JSON.stringify(data));
    if (!data) throw new Error("Player data not found");
    // Write updated balance back
    const updated = { ...data, balance: Math.round(newBalance * 100) / 100 };
    console.log(`[BJ] writing updated data:`, JSON.stringify(updated));
    await dsRequest("SET", "StockGame_v1", String(robloxUserId), updated);
    console.log(`[BJ] DataStore write complete`);
    // Also send a live command to update in-memory balance if player is online
    try {
        await pushCommandToRoblox({
            type: "SET_BALANCE",
            robloxUserId: robloxUserId,
            balance: updated.balance,
            issuedBy: "Blackjack",
            issuedAt: Date.now(),
        });
        console.log(`[BJ] SET_BALANCE command sent`);
    } catch (e) { console.log(`[BJ] SET_BALANCE command failed:`, e.message); }
    return updated.balance;
}

// Handle blackjack button interactions
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("bj_")) return; // ignore non-blackjack buttons
    const gameId = interaction.message.id;
    const game   = activeGames.get(gameId);
    if (!game) return interaction.reply({ content: "This game has expired.", ephemeral: true });
    if (interaction.user.id !== game.discordId) return interaction.reply({ content: "This isn't your game.", ephemeral: true });

    await interaction.deferUpdate();
    const { deck, playerHand, dealerHand } = game;

    if (interaction.customId === "bj_hit" || interaction.customId === "bj_double") {
        if (interaction.customId === "bj_double") {
            // Double down — double bet, one card only
            const data = await getPlayerData(game.robloxId);
            if (data && data.balance >= game.bet) {
                game.balance -= game.bet;
                game.bet *= 2;
            }
        }
        playerHand.push(deck.pop());
        const pv = handValue(playerHand);

        if (pv > 21) {
            // Bust
            await updateBalance(game.robloxId, game.balance);
            if (game.timeoutId) clearTimeout(game.timeoutId);
            activeGames.delete(gameId);
            return interaction.editReply({
                embeds: [bjEmbed(playerHand, dealerHand, game.bet, game.balance, "lose", false)],
                components: []
            });
        }
        if (pv === 21 || interaction.customId === "bj_double") {
            // Auto-stand on 21 or double down
            await resolveDealer(interaction, game, gameId);
            return;
        }
        // Continue playing
        return interaction.editReply({
            embeds: [bjEmbed(playerHand, dealerHand, game.bet, game.balance + game.bet, "playing", true)],
            components: [{
                type: 1,
                components: [
                    { type: 2, style: 1, label: "Hit", custom_id: "bj_hit" },
                    { type: 2, style: 4, label: "Stand", custom_id: "bj_stand" },
                ]
            }]
        });
    }

    if (interaction.customId === "bj_stand") {
        await resolveDealer(interaction, game, gameId);
    }
});

async function resolveDealer(interaction, game, gameId) {
    const { playerHand, dealerHand, deck } = game;
    // Dealer draws to 17
    while (handValue(dealerHand) < 17) dealerHand.push(deck.pop());

    const pv = handValue(playerHand);
    const dv = handValue(dealerHand);
    let status, balanceChange;

    if (dv > 21 || pv > dv) {
        status = "win"; balanceChange = game.bet * 2;
    } else if (pv === dv) {
        status = "push"; balanceChange = game.bet;
    } else {
        status = "lose"; balanceChange = 0;
    }

    const finalBalance = game.balance + balanceChange;
    await updateBalance(game.robloxId, finalBalance);
    if (game.timeoutId) clearTimeout(game.timeoutId);
    activeGames.delete(gameId);

    await interaction.editReply({
        embeds: [bjEmbed(playerHand, dealerHand, game.bet, finalBalance, status, false)],
        components: []
    });
}


// ================================================================
// TICKET SYSTEM
// ================================================================
const TICKET_CATEGORY_ID  = process.env.TICKET_CATEGORY_ID;
const TICKET_ARCHIVE_ID   = process.env.TICKET_ARCHIVE_ID;
const TICKET_PANEL_ID     = process.env.TICKET_PANEL_ID;
const TICKET_LOG_ID       = process.env.TICKET_LOG_ID;
const TICKET_STAFF_ROLE_ID = process.env.TICKET_STAFF_ROLE_ID; // role that can see all tickets
const activeTickets       = new Map(); // channelId -> { userId, category }
let ticketCounter         = 0; // increments for each new ticket

const TICKET_CATEGORIES = {
    support:   { label: "Support",     emoji: "🎧", color: 0x2962ff, description: "Get help with the game" },
    bugreport: { label: "Bug Report",  emoji: "🐛", color: 0xff9800, description: "Report a bug or issue" },
    appeal:    { label: "Appeal",      emoji: "⚖️", color: 0xff4444, description: "Appeal a ban or punishment" },
};

function buildTicketPanel() {
    const embed = new EmbedBuilder()
        .setTitle("🎫 Support Tickets")
        .setDescription("Click a button below to open a ticket. Please be descriptive and patient.")
        .addFields(
            { name: "🎧 Support",    value: "Get help with the game",          inline: true },
            { name: "🐛 Bug Report", value: "Report a bug or issue",            inline: true },
            { name: "⚖️ Appeal",     value: "Appeal a ban or punishment",       inline: true },
        )
        .setColor(0x2962ff)
        .setFooter({ text: "Grind The Graph • Support" });

    const row = {
        type: 1, components: [
            { type: 2, style: 1, emoji: "🎧", label: "Support",    custom_id: "ticket_open_support"   },
            { type: 2, style: 2, emoji: "🐛", label: "Bug Report", custom_id: "ticket_open_bugreport" },
            { type: 2, style: 4, emoji: "⚖️", label: "Appeal",     custom_id: "ticket_open_appeal"    },
        ]
    };

    return { embeds: [embed], components: [row] };
}

async function ensureTicketPanel(guild) {
    if (!TICKET_PANEL_ID) return;
    const ch = guild.channels.cache.get(TICKET_PANEL_ID);
    if (!ch) return;
    const messages = await ch.messages.fetch({ limit: 20 });
    const existing = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title === "🎫 Support Tickets");
    if (!existing) {
        await ch.send(buildTicketPanel());
        console.log("[Tickets] Panel posted");
    } else {
        console.log("[Tickets] Panel already exists");
    }

    // Restore activeTickets and ticket counter from existing channels
    const allCats = [TICKET_CATEGORY_ID, TICKET_ARCHIVE_ID].filter(Boolean);
    for (const catId of allCats) {
        for (const [id, channel] of guild.channels.cache) {
            if (channel.parentId === catId && channel.type === 0) {
                // Parse ticket number from name like "ticket-0042"
                const match = channel.name.match(/ticket-(\d+)/);
                if (match) {
                    const num = parseInt(match[1]);
                    if (num > ticketCounter) ticketCounter = num;
                }
                // Restore active tickets (non-archived only)
                if (catId === TICKET_CATEGORY_ID && !channel.name.startsWith("archived-")) {
                    const userOverwrite = channel.permissionOverwrites.cache.find(o => o.type === 1);
                    if (userOverwrite) {
                        activeTickets.set(id, { userId: userOverwrite.id, category: "Support" });
                        console.log(`[Tickets] Restored ticket: ${channel.name}`);
                    }
                }
            }
        }
    }
    console.log(`[Tickets] Counter resumed at ${ticketCounter}`);
}

async function logTicketAction(guild, action, user, channel, category) {
    if (!TICKET_LOG_ID) return;
    const logCh = guild.channels.cache.get(TICKET_LOG_ID);
    if (!logCh) return;
    await logCh.send({ embeds: [new EmbedBuilder()
        .setTitle(`🎫 Ticket ${action}`)
        .addFields(
            { name: "User",     value: `<@${user.id}> (${user.tag})`, inline: true },
            { name: "Category", value: category,                       inline: true },
            { name: "Channel",  value: channel ? `<#${channel.id}>` : "Deleted", inline: true },
        )
        .setColor(action === "Opened" ? 0x26a69a : action === "Closed" ? 0xff4444 : 0xf5a623)
        .setTimestamp()] });
}

// Handle ticket button interactions
client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("ticket_")) return;

    const [, action, ...rest] = interaction.customId.split("_");
    const guild  = interaction.guild;
    const member = interaction.member;

    // Open ticket
    if (action === "open") {
        const category = rest[0];
        const catData  = TICKET_CATEGORIES[category];
        if (!catData) return;

        // Check if user already has an open ticket
        const existing = [...activeTickets.entries()].find(([, d]) => d.userId === member.id);
        if (existing) {
            return interaction.reply({ ephemeral: true, content: `You already have an open ticket: <#${existing[0]}>` });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            // Create ticket channel
            ticketCounter++;
            const ticketNum = String(ticketCounter).padStart(4, "0");
            const ticketChannel = await guild.channels.create({
                name: `ticket-${ticketNum}`,
                type: 0, // text channel
                parent: TICKET_CATEGORY_ID ?? null,
                permissionOverwrites: [
                    { id: guild.id,    deny:  ["ViewChannel"] },
                    { id: member.id,   allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] },
                    ...(ADMIN_ROLE_ID      ? [{ id: ADMIN_ROLE_ID,       allow: ["ViewChannel", "SendMessages", "ReadMessageHistory", "ManageMessages"] }] : []),
                    ...(TICKET_STAFF_ROLE_ID ? [{ id: TICKET_STAFF_ROLE_ID, allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] }] : []),
                ],
            });

            activeTickets.set(ticketChannel.id, { userId: member.id, category: catData.label });

            // Send ticket welcome message
            const closeRow = { type: 1, components: [
                { type: 2, style: 4, emoji: "🔒", label: "Close Ticket", custom_id: "ticket_close" },
            ]};

            const staffPing = TICKET_STAFF_ROLE_ID ? `<@&${TICKET_STAFF_ROLE_ID}>` : "";
            await ticketChannel.send({
                content: `<@${member.id}> ${staffPing}`,
                embeds: [new EmbedBuilder()
                    .setTitle(`${catData.emoji} ${catData.label} Ticket`)
                    .setDescription(`Hello ${member.displayName}, thanks for opening a ticket!

Please describe your issue in detail and a staff member will assist you shortly.`)
                    .addFields({ name: "Category", value: catData.label, inline: true })
                    .setColor(catData.color)
                    .setTimestamp()
                    .setFooter({ text: "Click 🔒 to close this ticket" })],
                components: [closeRow],
            });

            await logTicketAction(guild, "Opened", member.user, ticketChannel, catData.label);
            await interaction.editReply({ content: `✅ Your ticket has been created: <#${ticketChannel.id}>` });
        } catch (err) {
            await interaction.editReply(`Error creating ticket: ${err.message}`);
        }
        return;
    }

    // Close ticket
    if (action === "close") {
        const channel = interaction.channel;
        const data    = activeTickets.get(channel.id);

        if (!data) return interaction.reply({ ephemeral: true, content: "This is not an active ticket channel." });

        const isOwner = data.userId === member.id;
        const isAdmin = ADMIN_ROLE_ID && member.roles.cache.has(ADMIN_ROLE_ID);
        if (!isOwner && !isAdmin) return interaction.reply({ ephemeral: true, content: "Only the ticket owner or staff can close this." });

        await interaction.deferReply();

        try {
            // Confirm close
            await interaction.editReply({ embeds: [new EmbedBuilder()
                .setTitle("🔒 Close Ticket?")
                .setDescription("This ticket will be archived. Click confirm to proceed.")
                .setColor(0xff4444)],
                components: [{ type: 1, components: [
                    { type: 2, style: 4, label: "Confirm Close", custom_id: "ticket_confirmclose" },
                    { type: 2, style: 2, label: "Cancel",        custom_id: "ticket_cancelclose"  },
                ]}]
            });
        } catch (err) {
            interaction.editReply(`Error: ${err.message}`);
        }
        return;
    }

    // Confirm close
    if (action === "confirmclose") {
        const channel = interaction.channel;
        const data    = activeTickets.get(channel.id);
        if (!data) return;

        await interaction.deferUpdate();

        try {
            const ticketUser = await client.users.fetch(data.userId).catch(() => null);

            // Build transcript
            let transcript = `📋 Ticket Transcript — ${channel.name}\n`;
            transcript += `Opened by: ${ticketUser?.tag || data.userId}\n`;
            transcript += `Category: ${data.category}\n`;
            transcript += `Date: ${new Date().toUTCString()}\n`;
            transcript += `${"=".repeat(50)}\n\n`;

            // Fetch all messages
            let allMessages = [];
            let lastId = null;
            while (true) {
                const options = { limit: 100 };
                if (lastId) options.before = lastId;
                const batch = await channel.messages.fetch(options);
                if (batch.size === 0) break;
                allMessages = allMessages.concat([...batch.values()]);
                lastId = batch.last().id;
                if (batch.size < 100) break;
            }
            allMessages.reverse();
            for (const msg of allMessages) {
                const time = msg.createdAt.toUTCString();
                transcript += `[${time}] ${msg.author.tag}: ${msg.content || "(embed/attachment)"}\n`;
            }

            // Send transcript to user via DM
            if (ticketUser) {
                try {
                    const buffer = Buffer.from(transcript, "utf-8");
                    await ticketUser.send({
                        embeds: [new EmbedBuilder()
                            .setTitle("🎫 Your ticket has been closed")
                            .setDescription(`Your **${data.category}** ticket has been archived. A transcript is attached below.`)
                            .setColor(0x787b86)
                            .setTimestamp()],
                        files: [{ attachment: buffer, name: `transcript-${channel.name}.txt` }]
                    });
                } catch {
                    console.log("[Tickets] Could not DM transcript to user (DMs may be closed)");
                }
            }

            // Archive: move to archive category and remove user's send permissions
            const archivePerms = [
                { id: guild.id,        deny:  ["ViewChannel"] },
                { id: data.userId,     deny:  ["ViewChannel"] },  // user can no longer see archived ticket
                ...(ADMIN_ROLE_ID        ? [{ id: ADMIN_ROLE_ID,         allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"] }] : []),
                ...(TICKET_STAFF_ROLE_ID ? [{ id: TICKET_STAFF_ROLE_ID,  allow: ["ViewChannel", "ReadMessageHistory"] }] : []),
            ];

            await channel.setParent(TICKET_ARCHIVE_ID || channel.parentId, { lockPermissions: false });
            await channel.permissionOverwrites.set(archivePerms);
            await channel.setName(`archived-${channel.name}`);

            await channel.send({ embeds: [new EmbedBuilder()
                .setTitle("🔒 Ticket Archived")
                .setDescription(`This ticket was closed by <@${interaction.member.id}>`)
                .setColor(0x787b86)
                .setTimestamp()] });

            activeTickets.delete(channel.id);
            await logTicketAction(guild, "Closed", interaction.member.user, channel, data.category);
        } catch (err) {
            console.error("[Tickets] Error archiving:", err.message);
        }
        return;
    }

    // Cancel close
    if (action === "cancelclose") {
        await interaction.update({ content: "Cancelled.", embeds: [], components: [] });
        return;
    }
});

// Post ticket panel on ready
client.once("ready", async () => {});  // placeholder - handled in main ready event
client.login(DISCORD_TOKEN);

const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("RBLX Stock Bot running"));
app.listen(BRIDGE_PORT, () => console.log(`[Bridge] Listening on port ${BRIDGE_PORT}`));
