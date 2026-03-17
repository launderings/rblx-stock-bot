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

async function pushCommandToRoblox(command) {
    const universe = ROBLOX_UNIVERSE_ID;
    const dsName   = encodeURIComponent(ROBLOX_DATASTORE_NAME);
    const entryKey = encodeURIComponent("PendingCommand");
    const baseUrl  = `https://apis.roblox.com/cloud/v2/universes/${universe}/data-stores/${dsName}/entries`;
    const entryUrl = `${baseUrl}/${entryKey}`;
    const payload  = JSON.stringify({ value: JSON.stringify(command) });
    const headers  = { "x-api-key": ROBLOX_OPEN_CLOUD_KEY, "content-type": "application/json" };

    let res = await fetch(entryUrl, { method: "PATCH", headers, body: payload });

    if (res.status === 404) {
        res = await fetch(`${baseUrl}?id=${entryKey}`, { method: "POST", headers, body: payload });
    }

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Roblox API error ${res.status}: ${text}`);
    }
    return {};
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("ready", () => {
    console.log(`[Bot] Logged in as ${client.user.tag}`);
});

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
    if (!isAdmin(interaction)) {
        return interaction.reply({ content: "No permission.", ephemeral: true });
    }

    await interaction.deferReply();
    const cmd = interaction.commandName;

    try {
        if (cmd === "crash") {
            const severity = interaction.options.getNumber("severity") ?? 0.4;
            const duration = interaction.options.getInteger("duration") ?? 30;
            const reason   = interaction.options.getString("reason") ?? "Market correction";
            const stockC = interaction.options.getString('stock') || null;
            await pushCommandToRoblox({ type: "CRASH", severity, duration, reason, symbol: stockC, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Market Crash Triggered", `**Severity:** -${Math.round(severity * 100)}%\n**Duration:** ${duration}s\n**Reason:** ${reason}`, 0xff4444)] });

        } else if (cmd === "boom") {
            const multiplier = interaction.options.getNumber("multiplier") ?? 1.3;
            const duration   = interaction.options.getInteger("duration") ?? 30;
            const reason     = interaction.options.getString("reason") ?? "Bull run";
            const stockB = interaction.options.getString('stock') || null;
            await pushCommandToRoblox({ type: "BOOM", multiplier, duration, reason, symbol: stockB, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Market Boom Triggered", `**Surge:** +${Math.round((multiplier - 1) * 100)}%\n**Duration:** ${duration}s\n**Reason:** ${reason}`, 0x26a69a)] });

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
            const stockF = interaction.options.getString('stock') || null;
            await pushCommandToRoblox({ type: "FREEZE", duration, symbol: stockF, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Market Frozen", `Trading halted for **${duration}s**`, 0x787b86)] });

        } else if (cmd === "unfreeze") {
            await pushCommandToRoblox({ type: "UNFREEZE", issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Market Unfrozen", "Trading resumed.", 0x26a69a)] });

        } else if (cmd === "setregime") {
            const regime = interaction.options.getString("regime");
            const stockR = interaction.options.getString('stock') || null;
            await pushCommandToRoblox({ type: "SET_REGIME", regime, symbol: stockR, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Regime Set", `Market forced into **${regime}** mode`, regime === "BULL" ? 0x26a69a : regime === "BEAR" ? 0xff4444 : 0x787b86)] });

        } else if (cmd === "resetdata") {
            const username = interaction.options.getString("username") || null;
            const balance  = interaction.options.getNumber("balance") ?? 10000;
            await pushCommandToRoblox({ type: "RESET_DATA", username, balance, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            const who = username ? `**${username}**` : "**all players**";
            await interaction.editReply({ embeds: [embed("Data Reset", `Reset ${who} to $${balance.toLocaleString()} balance and 0 shares`, 0x787b86)] });

        } else if (cmd === "setprice") {
            const price = interaction.options.getNumber("price");
            const stockP = interaction.options.getString('stock') || null;
            await pushCommandToRoblox({ type: "SET_PRICE", price, symbol: stockP, issuedBy: interaction.user.tag, issuedAt: Date.now() });
            await interaction.editReply({ embeds: [embed("Price Set", `Market price set to **$${price.toLocaleString()}**`, 0xf5a623)] });
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
