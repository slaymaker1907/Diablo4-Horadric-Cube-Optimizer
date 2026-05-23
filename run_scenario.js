const {
  buildEnv,
  runOptimization,
  summarizeRoot,
} = require('./d4cubeoptim-worker.js');

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
    sacrificeAffixId: "All Damage", // Legendary Aggressive source
    currentGAAffixes: [],
    strictMode: false
};

const target = {
    affixes: [
        { affixId: "Movement Speed", requireGA: false }, // Pragmatic
        { affixId: "Cooldown Reduction", requireGA: false }, // Pragmatic
        { affixId: "Maximum Life", requireGA: false }, // Protector
        { affixId: "Armor", requireGA: false } // Protector
    ]
};

const env = buildEnv(data, gaConfig, target);

// State: A legendary item with "All Damage" (Aggressive category)
// We want to see if it can bridge to Pragmatic.
const initialState = {
    affixes: [
        { affixId: "All Damage", isGA: true, enchanted: false },
        { affixId: "Thorns", isGA: false, enchanted: false },
        { affixId: "Armor", isGA: false, enchanted: false }
    ],
    isLegendary: true,
    enchantressUsed: false
};

const payload = {
    state: initialState,
    target: target,
    data: data,
    timeMs: 2000, // 2 seconds for simulation
    tree: null,
    depthLimit: 26,
    rolloutDepthLimit: 26,
    rolloutCount: 10,
    gaConfig: gaConfig
};

// Mock self.postMessage
global.self = {
    postMessage: (msg) => {
        if (msg.type === 'summary') {
            const sum = msg.summary;
            console.log(JSON.stringify({
                action: sum.action,
                successProb: sum.successProb,
                expectedSteps: sum.expectedSteps,
                candidateActions: sum.candidateActions.slice(0, 2).map(c => ({
                    action: c.action,
                    successProb: c.successProb,
                    expectedSteps: c.expectedSteps
                }))
            }, null, 2));
        }
    }
};

runOptimization(payload, 1);

