// Run once to register slash commands with Discord:
//   node deploy-commands.js

require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
    new SlashCommandBuilder()
        .setName("crash")
        .setDescription("Trigger a market crash")
        .addNumberOption(o => o.setName("severity").setDescription("Drop fraction 0.1–0.8 (default 0.4 = -40%)").setMinValue(0.05).setMaxValue(0.8))
        .addIntegerOption(o => o.setName("duration").setDescription("Seconds to force bear regime (default 30)").setMinValue(5).setMaxValue(300))
        .addStringOption(o => o.setName("reason").setDescription("Reason shown in-game")),

    new SlashCommandBuilder()
        .setName("boom")
        .setDescription("Trigger a market boom")
        .addNumberOption(o => o.setName("multiplier").setDescription("Price multiplier e.g. 1.3 = +30% (default 1.3)").setMinValue(1.05).setMaxValue(3.0))
        .addIntegerOption(o => o.setName("duration").setDescription("Seconds to force bull regime (default 30)").setMinValue(5).setMaxValue(300))
        .addStringOption(o => o.setName("reason").setDescription("Reason shown in-game")),

    new SlashCommandBuilder()
        .setName("givemoney")
        .setDescription("Give a specific player money")
        .addStringOption(o => o.setName("username").setDescription("Roblox username").setRequired(true))
        .addNumberOption(o => o.setName("amount").setDescription("Amount in dollars").setRequired(true).setMinValue(1).setMaxValue(10000000)),

    new SlashCommandBuilder()
        .setName("giveallmoney")
        .setDescription("Give all online players money")
        .addNumberOption(o => o.setName("amount").setDescription("Amount per player").setRequired(true).setMinValue(1).setMaxValue(1000000)),

    new SlashCommandBuilder()
        .setName("announce")
        .setDescription("Send an announcement to all players in-game")
        .addStringOption(o => o.setName("message").setDescription("Message to display").setRequired(true))
        .addIntegerOption(o => o.setName("duration").setDescription("Seconds to show (default 10)").setMinValue(3).setMaxValue(60)),

    new SlashCommandBuilder()
        .setName("freeze")
        .setDescription("Freeze the market (halt all trading)")
        .addIntegerOption(o => o.setName("duration").setDescription("Seconds to freeze (default 60)").setMinValue(5).setMaxValue(3600)),

    new SlashCommandBuilder()
        .setName("unfreeze")
        .setDescription("Unfreeze the market immediately"),

    new SlashCommandBuilder()
        .setName("setregime")
        .setDescription("Force the market into a specific regime")
        .addStringOption(o => o
            .setName("regime")
            .setDescription("Market regime")
            .setRequired(true)
            .addChoices(
                { name: "Bull (rising)", value: "BULL" },
                { name: "Bear (falling)", value: "BEAR" },
                { name: "Sideways (flat)", value: "SIDEWAYS" }
            )),
    new SlashCommandBuilder()
        .setName("resetdata")
        .setDescription("Wipe a player's balance and shares back to default")
        .addStringOption(o => o.setName("username").setDescription("Roblox username (leave blank to reset ALL players)"))
        .addNumberOption(o => o.setName("balance").setDescription("Starting balance to reset to (default 10000)").setMinValue(0)),

    new SlashCommandBuilder()
        .setName("setprice")
        .setDescription("Set the market price to a specific value")
        .addNumberOption(o => o.setName("price").setDescription("New price in dollars").setRequired(true).setMinValue(0.01).setMaxValue(999999)),

].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    console.log("Registering slash commands...");
    await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
    );
    console.log("Done!");
})();