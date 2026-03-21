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
        const data = await res.json();
        try { return JSON.parse(data.value); } catch { return data.value; }
    }

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
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once("ready", () => {
    console.log(`[Bot] Logged in as ${client.user.tag}`);
    // Poll for completed link verifications every 5s
    setInterval(pollLinkVerifications, 5000);
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

    if (cmd === "richlist") {
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

        } else if (cmd === "resetdata") {
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

        } else if (cmd === "purge") {
            const amount = interaction.options.getInteger("amount");
            await interaction.deferReply({ ephemeral: true });
            try {
                const deleted = await interaction.channel.bulkDelete(amount, true);
                await interaction.editReply(`🗑️ Deleted **${deleted.size}** message${deleted.size !== 1 ? "s" : ""}.`);
            } catch (err) {
                await interaction.editReply(`Error: ${err.message}`);
            }
        }

    } catch (err) {
        console.error("[Bot] Error:", err.message);
        await interaction.editReply(`Error: ${err.message}`);
    }
});

client.login(DISCORD_TOKEN);

const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("RBLX Stock Bot running"));
app.listen(BRIDGE_PORT, () => console.log(`[Bridge] Listening on port ${BRIDGE_PORT}`));
