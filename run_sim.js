const fs = require('fs');
const script = fs.readFileSync('./d4cubeoptim-worker.js', 'utf8');

// The script uses 'self.onmessage' and browser-like environment in some parts.
// We need to extract the functions or mock the environment to run the logic.

// eval(script) is risky but for this task we can extract the core logic by wrapping it.
// Alternatively, we can just append our driver code to the script and run it with node.

const driver = \`
const categories = {
    Aggressive: ["Vulnerable Damage", "DoT Damage", "All Damage", "Elemental Damage", "Thorns"],
    Pragmatic: ["Barrier Generation", "Cooldown Reduction", "Fortify Generation", "Healing Received", "Impairment Reduction", "Life Regeneration", "Lucky Hit Chance", "Movement Speed", "Potion Capacity", "Thorns", "Maximum Evade Charges", "Attacks reduce Evade Cooldown", "Evade grants Movement Speed"],
    Protector: ["Armor", "Damage Reduction", "Dodge Chance", "Fortify Generation", "Life on Hit", "Life on Kill", "Life Regeneration", "Maximum Life", "All Resistance", "Specific Resistances"],
    Resourceful: ["Lucky Hit Chance restore Resource", "Maximum Resource", "Resource Cost Reduction", "Resource on Kill", "Resource Regeneration"],
    Adept: ["Mainstat", "Skill Ranks"],
    Chromatic: ["Specific Resistances"]
};

const allUniqueAffixes = new Set();
for (const cat in categories) {
    categories[cat].forEach(a => allUniqueAffixes.add(a));
}

const affixes = Array.from(allUniqueAffixes).map(id => ({ id, name: id }));

const data = {
    categories,
    affixes
};

const gaConfig = {
    sacrificeAffixId: "",
    currentGAAffixes: ["All Resistance", "Armor"],
    strictMode: false
};

const target = {
    affixes: [
        { affixId: "Maximum Evade Charges", requireGA: false },
        { affixId: "Armor", requireGA: false },
        { affixId: "All Resistance", requireGA: true },
        { affixId: "Life on Kill", requireGA: false }
    ]
};

const env = buildEnv(data, gaConfig, target);

const initialState = {
    affixes: [
        { affixId: "All Resistance", isGA: true, enchanted: false },
        { affixId: "Armor", isGA: true, enchanted: false },
        { affixId: "Life on Kill", isGA: false, enchanted: true }
    ],
    isLegendary: false,
    enchantressUsed: true // because Life on Kill is enchanted
};

const actions = getValidActions(initialState, target, env);

const results = [];

for (const action of actions) {
    if (action.type !== 'add') continue;
    
    const hints = immediateSuccessHint(initialState, action, env, target);
    const breakdown = getActionProbabilityBreakdown(initialState, action, env);
    
    // Simulating 5000 episodes
    let totalWins = 0;
    let totalSteps = 0;
    const episodes = 5000;
    for (let i = 0; i < episodes; i++) {
        let current = cloneState(initialState);
        let steps = 0;
        while (steps < 30) {
            if (isTerminal(current, target, env)) {
                totalWins++;
                totalSteps += steps;
                break;
            }
            // Simplification: just follow the rollout logic
            const acts = getValidActions(current, target, env);
            const act = chooseRolloutAction(current, acts, env, target);
            if (!act) break;
            const outcomes = getActionOutcomes(current, act, env);
            current = sampleOutcome(outcomes);
            if (isCubeAction(act)) steps++;
        }
    }

    results.push({
        action,
        hints,
        breakdown: topBreakdown(breakdown),
        winRate: totalWins / episodes,
        avgSteps: totalWins > 0 ? totalSteps / totalWins : Infinity
    });
}

console.log(JSON.stringify(results, null, 2));
\`;

fs.writeFileSync('driver.js', script + '\\n' + driver);
