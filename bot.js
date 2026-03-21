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
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once("ready", () => {
    console.log(`[Bot] Logged in as ${client.user.tag}`);
    // Poll for completed link verifications every 5s
    setInterval(pollLinkVerifications, 5000);
});

// Prevent unhandled errors from crashing the bot
process.on("unhandledRejection", (err) => {
    console.error("[Bot] Unhandled rejection:", err.message);
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

            activeGames.set(msg.id, {
                deck, playerHand, dealerHand, bet,
                discordId: interaction.user.id,
                robloxId: link.robloxUserId,
                balance,
                originalBalance: data.balance,
            });

            // Auto-expire game after 5 minutes
            setTimeout(() => activeGames.delete(msg.id), 5 * 60 * 1000);

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
    activeGames.delete(gameId);

    await interaction.editReply({
        embeds: [bjEmbed(playerHand, dealerHand, game.bet, finalBalance, status, false)],
        components: []
    });
}

client.login(DISCORD_TOKEN);

const app = express();
app.use(express.json());
app.get("/", (req, res) => res.send("RBLX Stock Bot running"));
app.listen(BRIDGE_PORT, () => console.log(`[Bridge] Listening on port ${BRIDGE_PORT}`));
