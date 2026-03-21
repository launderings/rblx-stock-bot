require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const stockChoices = [
    { name: "NRMT - NeuralMint",           value: "NRMT" },
    { name: "ALGF - AlgoForge",            value: "ALGF" },
    { name: "QNTG - QuantumGrid",          value: "QNTG" },
    { name: "BYTV - ByteVest",             value: "BYTV" },
    { name: "VLTA - Voltara Energy",       value: "VLTA" },
    { name: "APXF - Apex Fusion",          value: "APXF" },
    { name: "GRDF - GridFuel",             value: "GRDF" },
    { name: "HLCR - HelioCore",            value: "HLCR" },
    { name: "IRCD - IronClad Systems",     value: "IRCD" },
    { name: "SNTL - Sentinel Dynamics",    value: "SNTL" },
    { name: "TTWK - TitanWorks",          value: "TTWK" },
    { name: "AEGM - Aegis Manufacturing",  value: "AEGM" },
    { name: "CRPT - CrestPoint Capital",   value: "CRPT" },
    { name: "BLDG - BlueLedger",           value: "BLDG" },
    { name: "NBMK - NorthBridge Markets",  value: "NBMK" },
    { name: "PMYD - PrimeYield",           value: "PMYD" },
    { name: "NXCR - Nexcore Systems",      value: "NXCR" },
    { name: "VLTX - Voltex Industries",    value: "VLTX" },
    { name: "PLHR - Placeholder Corp",     value: "PLHR" },
];

const commands = [
    // ── Economy (public) ──────────────────────────────────────
    new SlashCommandBuilder()
        .setName("link")
        .setDescription("Link your Discord account to your Roblox account"),

    new SlashCommandBuilder()
        .setName("balance")
        .setDescription("Check your in-game cash balance"),

    new SlashCommandBuilder()
        .setName("portfolio")
        .setDescription("View your full portfolio — balance, shares, and net worth"),

    new SlashCommandBuilder()
        .setName("leaderboard")
        .setDescription("See the top 10 wealthiest players"),

    new SlashCommandBuilder()
        .setName("blackjack")
        .setDescription("Play blackjack using your in-game balance")
        .addNumberOption(o => o.setName("bet").setDescription("Amount to bet").setRequired(true).setMinValue(1).setMaxValue(1000000)),

    new SlashCommandBuilder()
        .setName("bj")
        .setDescription("Play blackjack using your in-game balance (shortcut)")
        .addNumberOption(o => o.setName("bet").setDescription("Amount to bet").setRequired(true).setMinValue(1).setMaxValue(1000000)),

    // ── Admin ─────────────────────────────────────────────────
    new SlashCommandBuilder()
        .setName("crash")
        .setDescription("Trigger a market crash")
        .addNumberOption(o => o.setName("severity").setDescription("Drop fraction 0.1-0.8 (default 0.4 = -40%)").setMinValue(0.05).setMaxValue(0.8))
        .addIntegerOption(o => o.setName("duration").setDescription("Seconds to force bear regime (default 30)").setMinValue(5).setMaxValue(300))
        .addStringOption(o => o.setName("reason").setDescription("Reason shown in-game"))
        .addStringOption(o => o.setName("stock").setDescription("Target stock (blank = all)").addChoices(...stockChoices)),

    new SlashCommandBuilder()
        .setName("boom")
        .setDescription("Trigger a market boom")
        .addNumberOption(o => o.setName("multiplier").setDescription("Price multiplier e.g. 1.3 = +30% (default 1.3)").setMinValue(1.05).setMaxValue(3.0))
        .addIntegerOption(o => o.setName("duration").setDescription("Seconds to force bull regime (default 30)").setMinValue(5).setMaxValue(300))
        .addStringOption(o => o.setName("reason").setDescription("Reason shown in-game"))
        .addStringOption(o => o.setName("stock").setDescription("Target stock (blank = all)").addChoices(...stockChoices)),

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
        .addIntegerOption(o => o.setName("duration").setDescription("Seconds to freeze (default 60)").setMinValue(5).setMaxValue(3600))
        .addStringOption(o => o.setName("stock").setDescription("Target stock (blank = all)").addChoices(...stockChoices)),

    new SlashCommandBuilder()
        .setName("unfreeze")
        .setDescription("Unfreeze the market immediately"),

    new SlashCommandBuilder()
        .setName("setregime")
        .setDescription("Force the market into a specific regime")
        .addStringOption(o => o.setName("regime").setDescription("Market regime").setRequired(true)
            .addChoices(
                { name: "Bull (rising)",   value: "BULL"     },
                { name: "Bear (falling)",  value: "BEAR"     },
                { name: "Sideways (flat)", value: "SIDEWAYS" }
            ))
        .addStringOption(o => o.setName("stock").setDescription("Target stock (blank = all)").addChoices(...stockChoices)),

    new SlashCommandBuilder()
        .setName("resetdata")
        .setDescription("Wipe a player's balance and shares back to default")
        .addStringOption(o => o.setName("username").setDescription("Roblox username (leave blank to reset ALL players)"))
        .addNumberOption(o => o.setName("balance").setDescription("Starting balance to reset to (default 10000)").setMinValue(0)),

    new SlashCommandBuilder()
        .setName("setprice")
        .setDescription("Set the market price to a specific value")
        .addNumberOption(o => o.setName("price").setDescription("New price in dollars").setRequired(true).setMinValue(0.01).setMaxValue(999999))
        .addStringOption(o => o.setName("stock").setDescription("Target stock (blank = PLHR)").addChoices(...stockChoices)),

    new SlashCommandBuilder()
        .setName("purge")
        .setDescription("Delete messages from this channel (admin only)")
        .addIntegerOption(o => o.setName("amount").setDescription("Number of messages to delete (1-100)").setRequired(true).setMinValue(1).setMaxValue(100)),

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
