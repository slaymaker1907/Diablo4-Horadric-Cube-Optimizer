(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.d4cubeoptimGearSlotLegality = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const ANY_GEAR_SLOT = "Any";
  const GEAR_SLOTS = Object.freeze([
    ANY_GEAR_SLOT,
    "Helm",
    "Chest",
    "Gloves",
    "Pants",
    "Boots",
    "Amulet",
    "Ring",
    "1H Weapon",
    "2H Weapon",
    "Offhand",
    "Shield",
  ]);

  // Class-aware skill catalog — kept in sync with docs/official-by-category.md
  // and config.js.  The slot legality table below replaces the prior
  // "Specific Skill Ranks" and "Category Skill Ranks" placeholders with the
  // full enumerated list of skill names; class-based narrowing happens
  // separately at runtime via state.class.
  const CLASS_AGNOSTIC_GENERAL_SKILL_NAMES = [
    "to Basic Skills",
    "to Core Skills",
    "to Defensive Skills",
  ];

  const TO_ALL_SKILLS_NAME = "to All Skills";

  const CLASS_SKILLS = {
    Barbarian: {
      specific: [
        "to Bash", "to Flay", "to Frenzy", "to Lunging Strike", "to Double Swing",
        "to Hammer of the Ancients", "to Rend", "to Upheaval", "to Whirlwind",
        "to Challenging Shout", "to Charge", "to Death Blow", "to Ground Stomp",
        "to Iron Skin", "to Kick", "to Leap", "to Rallying Cry", "to Rupture",
        "to Steel Grasp", "to War Cry", "to Mighty Throw",
      ],
      general: [
        "to Brawling Skills", "to Weapon Mastery Skills", "to Ancient Skills",
        "to Dust Devil Skills", "to Earthquake Skills", "to Iron Shrapnel Skills",
        "to Combat Skills", "to Martial Skills",
      ],
    },
    Druid: {
      specific: [
        "to Claw", "to Earth Spike", "to Maul", "to Storm Strike", "to Wind Shear",
        "to Landslide", "to Lightning Storm", "to Pulverize", "to Shred", "to Tornado",
        "to Blood Howl", "to Boulder", "to Cyclone Armor", "to Debilitating Roar",
        "to Earthen Bulwark", "to Hurricane", "to Rabies", "to Ravens", "to Trample",
        "to Poison Creeper", "to Wolves", "to Stone Burst",
      ],
      general: [
        "to Wrath Skills", "to Companion Skills", "to Human Skills", "to Versatile Skills",
        "to Earth Skills", "to Nature Magic Skills", "to Shapeshifting Skills",
        "to Storm Skills", "to Werebear Skills", "to Werewolf Skills",
      ],
    },
    Necromancer: {
      specific: [
        "to Bone Splinters", "to Decompose", "to Hemorrhage", "to Reap", "to Blight",
        "to Blood Lance", "to Blood Surge", "to Bone Spear", "to Sever", "to Blood Mist",
        "to Bone Prison", "to Bone Spirit", "to Corpse Explosion", "to Corpse Tendrils",
        "to Decrepify", "to Iron Maiden", "to Golem", "to Skeleton Mage", "to Skeleton Warrior",
      ],
      general: [
        "to Corpse Skills", "to Curse Skills", "to Macabre Skills", "to Blood Skills",
        "to Bone Skills", "to Darkness Skills", "to Minion Skills",
      ],
    },
    Rogue: {
      specific: [
        "to Blade Shift", "to Forceful Arrow", "to Heartseeker", "to Invigorating Strike",
        "to Puncture", "to Barrage", "to Flurry", "to Penetrating Shot", "to Rapid Fire",
        "to Twisting Blades", "to Caltrops", "to Cold Imbuement", "to Concealment",
        "to Dark Shroud", "to Dash", "to Poison Imbuement", "to Poison Trap",
        "to Shadow Imbuement", "to Shadow Step", "to Smoke Grenade", "to Dance of Knives",
      ],
      general: [
        "to Agility Skills", "to Imbuement Skills", "to Subterfuge Skills",
        "to Arrow Storm Skills", "to Grenade Skills", "to Shade Skills",
        "to Cutthroat Skills", "to Marksman Skills", "to Trap Skills",
      ],
    },
    Sorceror: {
      specific: [
        "to Spark", "to Fire Bolt", "to Frost Bolt", "to Arc Lash", "to Fireball",
        "to Ice Shards", "to Chain Lightning", "to Charged Bolts", "to Incinerate",
        "to Frozen Orb", "to Ball Lightning", "to Blizzard", "to Firewall", "to Flame Shield",
        "to Frost Nova", "to Hydra", "to Ice Armor", "to Ice Blades", "to Lightning Spear",
        "to Meteor", "to Teleport", "to Familiar", "to Vortex",
      ],
      general: [
        "to Conjuration Skills", "to Mastery Skills", "to Frost Skills",
        "to Pyromancy Skills", "to Shock Skills",
      ],
    },
    Spiritborn: {
      specific: [
        "to Toxic Skin", "to Touch of Death", "to Soar", "to Scourge", "to Rushing Claw",
        "to Razor Wings", "to Ravager", "to Payback", "to Counterattack",
        "to Concussive Stomp", "to Armored Hide", "to Stinger", "to Rake", "to Quill Volley",
        "to Crushing Hand", "to Withering Fist", "to Thunderspike", "to Thrash",
        "to Rock Splitter",
      ],
      general: [
        "to Potency Skills", "to Focus Skills", "to Centipede Skills",
        "to Eagle Skills", "to Gorilla Skills", "to Jaguar Skills",
      ],
    },
    Paladin: {
      specific: [
        "to Advance", "to Brandish", "to Clash", "to Holy Bolt", "to Blessed Hammer",
        "to Blessed Shield", "to Divine Lance", "to Shield Bash", "to Zeal",
        "to Defiance Aura", "to Fanaticism Aura", "to Holy Light Aura", "to Condemn",
        "to Consecration", "to Purify", "to Spear of the Heavens", "to Aegis",
        "to Falling Star", "to Rally", "to Shield Charge",
      ],
      general: [
        "to Zealot Skills", "to Aura Skills", "to Judicator Skills", "to Justice Skills",
        "to Valor Skills", "to Disciple Skills", "to Juggernaut Skills",
      ],
    },
    Warlock: {
      specific: [
        "to Command Fallen", "to Doom", "to Hellion Sting", "to Molten Bomb",
        "to Blazing Scream", "to Bombardment", "to Dread Claws", "to Hell Fracture",
        "to Umbral Chains", "to Dark Prison", "to Infernal Breath", "to Nether Step",
        "to Profane Sentinel", "to Rampage", "to Sigil of Chaos", "to Sigil of Subversion",
        "to Sigil of Summons", "to Tortured Wretch", "to Tyrant's Grasp", "to Wall of Agony",
      ],
      general: [
        "to Abyss Skills", "to Demonology Skills", "to Hellfire Skills",
        "to Occult Skills", "to Archfiend Skills", "to Sigil Skills",
      ],
    },
  };

  const ALL_SKILL_RANK_NAMES = [
    ...CLASS_AGNOSTIC_GENERAL_SKILL_NAMES,
    TO_ALL_SKILLS_NAME,
    ...Object.values(CLASS_SKILLS).flatMap(({ specific, general }) => [...specific, ...general]),
  ];

  const SKILL_MULTIPLIER_NAMES = [
    "Basic Skill Damage Multiplier",
    "Core Skill Damage Multiplier",
    "Backstab Damage Multiplier",
  ];

  const SLOT_TO_AFFIX_NAMES = Object.freeze({
    Helm: Object.freeze([
      "Mainstat",
      "Maximum Life",
      "Armor",
      "Cooldown Reduction",
      "Maximum Resource",
      "Life on Hit",
      "Life on Kill",
      "Life Regeneration",
      "Barrier Generation",
      "Fortify Generation",
      "Healing Received",
      "Impairment Reduction",
      "All Resistance",
      "Specific Resistance (Physical)",
      "Specific Resistance (Fire)",
      "Specific Resistance (Cold)",
      "Specific Resistance (Lightning)",
      "Specific Resistance (Poison)",
      "Specific Resistance (Shadow)",
      "Thorns",
      "Lucky Hit Chance",
      "Resource Cost Reduction",
      "Resource Regeneration",
      ...ALL_SKILL_RANK_NAMES,
    ]),
    Chest: Object.freeze([
      "Mainstat",
      "Maximum Life",
      "Armor",
      "Damage Reduction",
      "Thorns",
      "Life Regeneration",
      "Barrier Generation",
      "Fortify Generation",
      "Healing Received",
      "All Resistance",
      "Specific Resistance (Physical)",
      "Specific Resistance (Fire)",
      "Specific Resistance (Cold)",
      "Specific Resistance (Lightning)",
      "Specific Resistance (Poison)",
      "Specific Resistance (Shadow)",
      "Life on Kill",
      "Maximum Resource",
      "Resource Regeneration",
      "Resource Cost Reduction",
      "Impairment Reduction",
      ...ALL_SKILL_RANK_NAMES,
    ]),
    Gloves: Object.freeze([
      "Mainstat",
      "Maximum Life",
      "Armor",
      "Attack Speed",
      "Critical Strike Chance",
      "Critical Strike Damage",
      "Lucky Hit Chance",
      "Lucky Hit Chance restore Resource",
      "Life on Hit",
      "Life Regeneration",
      "All Damage",
      "Vulnerable Damage",
      "Elemental Damage (Physical)",
      "Elemental Damage (Fire)",
      "Elemental Damage (Cold)",
      "Elemental Damage (Lightning)",
      "Elemental Damage (Poison)",
      "Elemental Damage (Shadow)",
      "Barrier Generation",
      "All Resistance",
      "Specific Resistance (Physical)",
      "Specific Resistance (Fire)",
      "Specific Resistance (Cold)",
      "Specific Resistance (Lightning)",
      "Specific Resistance (Poison)",
      "Specific Resistance (Shadow)",
      "Resource Cost Reduction",
      "Cooldown Reduction",
      ...SKILL_MULTIPLIER_NAMES,
      ...ALL_SKILL_RANK_NAMES,
    ]),
    Pants: Object.freeze([
      "Mainstat",
      "Maximum Life",
      "Armor",
      "Damage Reduction",
      "Dodge Chance",
      "Thorns",
      "Potion Capacity",
      "Impairment Reduction",
      "Life Regeneration",
      "Barrier Generation",
      "Fortify Generation",
      "Healing Received",
      "All Resistance",
      "Specific Resistance (Physical)",
      "Specific Resistance (Fire)",
      "Specific Resistance (Cold)",
      "Specific Resistance (Lightning)",
      "Specific Resistance (Poison)",
      "Specific Resistance (Shadow)",
      "Life on Kill",
      "Resource Regeneration",
      ...ALL_SKILL_RANK_NAMES,
    ]),
    Boots: Object.freeze([
      "Mainstat",
      "Maximum Life",
      "Armor",
      "Movement Speed",
      "Dodge Chance",
      "Impairment Reduction",
      "Life Regeneration",
      "Fortify Generation",
      "Healing Received",
      "Maximum Evade Charges",
      "Attacks reduce Evade Cooldown",
      "Evade grants Movement Speed",
      "All Resistance",
      "Specific Resistance (Physical)",
      "Specific Resistance (Fire)",
      "Specific Resistance (Cold)",
      "Specific Resistance (Lightning)",
      "Specific Resistance (Poison)",
      "Specific Resistance (Shadow)",
      "Life on Kill",
      "Resource Regeneration",
      "Barrier Generation",
      ...ALL_SKILL_RANK_NAMES,
    ]),
    Amulet: Object.freeze([
      "Mainstat",
      "Maximum Life",
      "All Damage",
      "Attack Speed",
      "Critical Strike Chance",
      "Cooldown Reduction",
      "Movement Speed",
      "Damage Reduction",
      "Impairment Reduction",
      "Resource Cost Reduction",
      "Elemental Damage (Physical)",
      "Elemental Damage (Fire)",
      "Elemental Damage (Cold)",
      "Elemental Damage (Lightning)",
      "Elemental Damage (Poison)",
      "Elemental Damage (Shadow)",
      "All Resistance",
      "Vulnerable Damage",
      "Critical Strike Damage",
      "DoT Damage",
      "Lucky Hit Chance",
      "Life Regeneration",
      "Life on Hit",
      "Resource on Kill",
      "Armor",
      "Specific Resistance (Physical)",
      "Specific Resistance (Fire)",
      "Specific Resistance (Cold)",
      "Specific Resistance (Lightning)",
      "Specific Resistance (Poison)",
      "Specific Resistance (Shadow)",
      "Maximum Resource",
      ...SKILL_MULTIPLIER_NAMES,
      ...ALL_SKILL_RANK_NAMES,
    ]),
    Ring: Object.freeze([
      "Mainstat",
      "Maximum Life",
      "Attack Speed",
      "Critical Strike Chance",
      "Critical Strike Damage",
      "Vulnerable Damage",
      "DoT Damage",
      "Lucky Hit Chance",
      "Maximum Resource",
      "Resource Regeneration",
      "Cooldown Reduction",
      "Life on Hit",
      "All Resistance",
      "Specific Resistance (Physical)",
      "Specific Resistance (Fire)",
      "Specific Resistance (Cold)",
      "Specific Resistance (Lightning)",
      "Specific Resistance (Poison)",
      "Specific Resistance (Shadow)",
      "Elemental Damage (Physical)",
      "Elemental Damage (Fire)",
      "Elemental Damage (Cold)",
      "Elemental Damage (Lightning)",
      "Elemental Damage (Poison)",
      "Elemental Damage (Shadow)",
      "Life Regeneration",
      "Life on Kill",
      "Resource on Kill",
      "Armor",
      "All Damage",
      "Resource Cost Reduction",
      ...SKILL_MULTIPLIER_NAMES,
    ]),
    "1H Weapon": Object.freeze([
      "Mainstat",
      "Maximum Life",
      "Maximum Resource",
      "Weapon Damage",
      "All Damage",
      "Attack Speed",
      "Critical Strike Damage",
      "Vulnerable Damage",
      "DoT Damage",
      "Elemental Damage (Physical)",
      "Elemental Damage (Fire)",
      "Elemental Damage (Cold)",
      "Elemental Damage (Lightning)",
      "Elemental Damage (Poison)",
      "Elemental Damage (Shadow)",
      "Life on Hit",
      "Life on Kill",
      "Resource on Kill",
      "Resource Cost Reduction",
      "Lucky Hit Chance restore Resource",
      ...SKILL_MULTIPLIER_NAMES,
      ...ALL_SKILL_RANK_NAMES,
    ]),
    "2H Weapon": Object.freeze([
      "Mainstat",
      "Maximum Life",
      "Maximum Resource",
      "Weapon Damage",
      "All Damage",
      "Attack Speed",
      "Critical Strike Damage",
      "Vulnerable Damage",
      "DoT Damage",
      "Elemental Damage (Physical)",
      "Elemental Damage (Fire)",
      "Elemental Damage (Cold)",
      "Elemental Damage (Lightning)",
      "Elemental Damage (Poison)",
      "Elemental Damage (Shadow)",
      "Life on Hit",
      "Life on Kill",
      "Resource on Kill",
      "Resource Cost Reduction",
      "Lucky Hit Chance restore Resource",
      ...SKILL_MULTIPLIER_NAMES,
      ...ALL_SKILL_RANK_NAMES,
    ]),
    Offhand: Object.freeze([
      "Mainstat",
      "Maximum Life",
      "Cooldown Reduction",
      "Critical Strike Chance",
      "Lucky Hit Chance",
      "Lucky Hit Chance restore Resource",
      "Maximum Resource",
      "Resource Cost Reduction",
      "Resource Regeneration",
      "Life on Hit",
      "Life on Kill",
      "Resource on Kill",
      "All Damage",
      "Critical Strike Damage",
      "DoT Damage",
      "Elemental Damage (Physical)",
      "Elemental Damage (Fire)",
      "Elemental Damage (Cold)",
      "Elemental Damage (Lightning)",
      "Elemental Damage (Poison)",
      "Elemental Damage (Shadow)",
      "Weapon Damage",
      ...ALL_SKILL_RANK_NAMES,
    ]),
    Shield: Object.freeze([
      "Mainstat",
      "Maximum Life",
      "Armor",
      "Damage Reduction",
      "Thorns",
      "Cooldown Reduction",
      "Critical Strike Chance",
      "Lucky Hit Chance",
      "Lucky Hit Chance restore Resource",
      "Resource Cost Reduction",
      "All Resistance",
      "Life Regeneration",
      "Life on Hit",
      "Resource on Kill",
      "Specific Resistance (Physical)",
      "Specific Resistance (Fire)",
      "Specific Resistance (Cold)",
      "Specific Resistance (Lightning)",
      "Specific Resistance (Poison)",
      "Specific Resistance (Shadow)",
      "Impairment Reduction",
      "Healing Received",
      ...ALL_SKILL_RANK_NAMES,
    ]),
  });

  function normalizeAffixName(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  const affixNameToGearSlots = Object.create(null);
  Object.entries(SLOT_TO_AFFIX_NAMES).forEach(([slot, names]) => {
    names.forEach((name) => {
      const normalized = normalizeAffixName(name);
      if (!normalized) {
        return;
      }
      if (!affixNameToGearSlots[normalized]) {
        affixNameToGearSlots[normalized] = [];
      }
      if (!affixNameToGearSlots[normalized].includes(slot)) {
        affixNameToGearSlots[normalized].push(slot);
      }
    });
  });

  const AFFIX_NAME_TO_GEAR_SLOTS = Object.freeze(
    Object.fromEntries(
      Object.entries(affixNameToGearSlots).map(([name, slots]) => [name, Object.freeze(slots.slice())])
    )
  );

  function getLegalGearSlotsForAffixName(name) {
    const normalized = normalizeAffixName(name);
    if (!normalized) {
      return null;
    }
    const slots = AFFIX_NAME_TO_GEAR_SLOTS[normalized];
    return Array.isArray(slots) ? slots.slice() : null;
  }

  function isAffixNameLegalForGearSlot(name, gearSlot) {
    if (!gearSlot || gearSlot === ANY_GEAR_SLOT) {
      return true;
    }
    const legalSlots = getLegalGearSlotsForAffixName(name);
    if (!legalSlots) {
      return true;
    }
    return legalSlots.includes(gearSlot);
  }

  return Object.freeze({
    ANY_GEAR_SLOT,
    GEAR_SLOTS,
    SLOT_TO_AFFIX_NAMES,
    AFFIX_NAME_TO_GEAR_SLOTS,
    normalizeAffixName,
    getLegalGearSlotsForAffixName,
    isAffixNameLegalForGearSlot,
  });
});
