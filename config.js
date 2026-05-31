(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  }
  root.d4cubeoptimConfig = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const CLASSES = [
    "Any",
    "Barbarian",
    "Druid",
    "Necromancer",
    "Rogue",
    "Sorceror",
    "Spiritborn",
    "Paladin",
    "Warlock",
  ];

  // Per-class skill catalog drawn from docs/official-by-category.md.
  // "specific" = single-skill ranks (e.g. "to Bash").
  // "general"  = per-category ranks (e.g. "to Brawling Skills").
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
        "to Rock Splitter", "to Vortex",
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

  const CLASS_AGNOSTIC_GENERAL_SKILLS = [
    "to Basic Skills",
    "to Core Skills",
    "to Defensive Skills",
  ];

  // Expand the class catalog into Adept catalog entries with family tags.
  // Family rolling: each member carries familyRollWeight = 1, meaning the
  // family contributes a single normalized "weight 1" to the prism total
  // regardless of how many members are present. Within the family, each
  // member is equally likely. See docs/game-mechanics.md.
  function buildAdeptSkillEntries() {
    const entries = [];

    for (const name of CLASS_AGNOSTIC_GENERAL_SKILLS) {
      entries.push({ name, family: "class-agnostic-general", familyRollWeight: 1 });
    }

    for (const className of Object.keys(CLASS_SKILLS)) {
      const { specific, general } = CLASS_SKILLS[className];
      for (const name of general) {
        entries.push({ name, family: "class-specific-general", familyRollWeight: 1, class: className });
      }
      for (const name of specific) {
        entries.push({ name, family: "specific-skill", familyRollWeight: 1, class: className });
      }
    }

    return entries;
  }

  return {
    // Bumped on ANY change to the roll model, solver, or weights (a superset of
    // WORKER_VERSION). The browser invalidates persisted outcome-tracking data
    // when this changes; scripts/learn-weights-from-tracking.js bumps it after
    // patching LEARNED_WEIGHTS. See docs/game-mechanics.md.
    MODEL_VERSION: "2026-05-30-m4",

    // Learned roll weights, keyed by learning-unit key (see weight-tracking.js:
    //   "affix:<id>"   -> rollWeight for that singleton affix
    //   "family:<fam>" -> familyRollWeight (family total) for a skill family
    //   "tied:<fam>"   -> family TOTAL for elemental-damage / specific-resistance
    //                     (per-member rollWeight = total / member count)
    // `{}` means pure baseline (every weight = 1). Regenerated by
    // scripts/learn-weights-from-tracking.js — do not hand-edit the block below.
    // BEGIN LEARNED_WEIGHTS
    LEARNED_WEIGHTS: {
      "affix:mainstat": 1.7309,
      "family:class-specific-general": 0.2838,
      "family:specific-skill": 1.4191,
      "family:class-agnostic-general": 0.2838,
      "affix:lucky-hit-chance-restore-resource": 0.8023,
      "affix:maximum-resource": 0.1974,
      "affix:resource-cost-reduction": 0.1974,
      "affix:resource-on-kill": 1.3372,
      "affix:all-damage": 0.1304,
      "affix:attack-speed": 0.1304,
      "family:skill-multiplier": 0.1304,
      "affix:critical-strike-damage": 0.9127,
      "affix:dot-damage": 0.9127,
      "affix:vulnerable-damage": 0.1304,
      "affix:weapon-damage": 1.9558,
      "affix:resource-regeneration": 1.1113,
      "affix:all-resistance": 0.5074,
      "affix:armor": 0.1691,
      "affix:damage-reduction": 0.6396,
      "affix:fortify-generation": 0.1691,
      "affix:life-on-kill": 0.5074,
      "affix:life-regeneration": 1.1839,
      "affix:maximum-life": 1.8605,
      "tied:specific-resistance": 4.7358,
      "affix:thorns": 0.6396,
      "affix:dodge-chance": 0.5244
    },
    // END LEARNED_WEIGHTS

    DAMAGE_TYPES: ["Physical", "Fire", "Cold", "Shadow", "Lightning", "Poison"],

    CLASSES,
    CLASS_SKILLS,
    CLASS_AGNOSTIC_GENERAL_SKILLS,

    // Affix names per prism category.
    // "Elemental Damage" and "Specific Resistance" are sentinel strings: the HTML
    // expands them into per-element typed-affix objects using DAMAGE_TYPES.
    //
    // Entries may be plain strings or objects.  Objects can carry:
    //   - family:           groups the affix into a family for state-key collapsing.
    //   - familyRollWeight: marks the family as a "family-level" roll.  Per-member
    //                       effective weight = familyRollWeight / family-count-in-pool,
    //                       so the family rolls once at the family level (equally with
    //                       singleton affixes) and then equally within the family.
    //                       Omit (or set to 0) to keep per-subtype weights (current
    //                       Elemental Damage / Specific Resistance behavior).
    //   - class:            restricts the affix to a specific character class.  Absent
    //                       means class-agnostic.  When state.class is set to a concrete
    //                       class, mismatched affixes are filtered out of the pool.
    CATEGORY_TO_AFFIX_NAMES: {
      Aggressive: [
        "Mainstat",
        "Weapon Damage",
        "Attack Speed",
        "Critical Strike Chance",
        "Critical Strike Damage",
        "Vulnerable Damage",
        "DoT Damage",
        "All Damage",
        "Elemental Damage",
        "Thorns",
        { name: "Basic Skill Damage Multiplier",    family: "skill-multiplier", familyRollWeight: 1 },
        { name: "Core Skill Damage Multiplier",     family: "skill-multiplier", familyRollWeight: 1 },
        { name: "Backstab Damage Multiplier",       family: "skill-multiplier", familyRollWeight: 1 },
      ],
      Pragmatic: [
        "Barrier Generation",
        "Cooldown Reduction",
        "Fortify Generation",
        "Healing Received",
        "Impairment Reduction",
        "Life Regeneration",
        "Lucky Hit Chance",
        "Movement Speed",
        "Potion Capacity",
        "Thorns",
        "Maximum Evade Charges",
        "Attacks reduce Evade Cooldown",
        "Evade grants Movement Speed",
      ],
      Protector: [
        "Armor",
        "Damage Reduction",
        "Dodge Chance",
        "Fortify Generation",
        "Life on Hit",
        "Life on Kill",
        "Life Regeneration",
        "Maximum Life",
        "All Resistance",
        "Specific Resistance",
        "Thorns",
      ],
      Resourceful: [
        "Lucky Hit Chance restore Resource",
        "Maximum Resource",
        "Resource Cost Reduction",
        "Resource on Kill",
        "Resource Regeneration",
      ],
      Adept: [
        "Mainstat",
        "to All Skills",
        ...buildAdeptSkillEntries(),
      ],
      Chromatic: [
        "Specific Resistance",
      ],
    },

    // Per-operation category overrides for affixes that behave differently per
    // operation type.  Keys are exact affix names.  Missing operation types fall
    // back to the affix's default category membership.
    // Empty arrays mean the affix cannot be targeted by that operation at all.
    OPERATION_CATEGORY_OVERRIDES: {
      Thorns: {
        add:     ["Aggressive"],
        focused: ["Protector"],
        chaotic: ["Protector"],
        remove:  ["Pragmatic"],
      },
      // "to All Skills" is enchant-only: it conceptually lives in the Adept prism
      // pool but cannot be added, rerolled, or removed by any cube recipe — only
      // the Enchantress can place it.  Mirrors the prior "Category Skill Ranks"
      // pattern, except that the per-category general skills (e.g. "to Brawling
      // Skills") are now cube-modifiable as ordinary Adept entries.
      "to All Skills": {
        add:     [],
        focused: [],
        chaotic: [],
        remove:  [],
      },
    },

    // Migrate old affix IDs (localStorage / URL) to current canonical IDs.
    // Empty string blanks the slot so the user re-picks a specific skill.
    LEGACY_AFFIX_ID_MAP: {
      "elemental-damage":      "elemental-damage-physical",
      "specific-resistances":  "specific-resistance-physical",
      "skill-ranks":           "",
      "specific-skill-ranks":  "",
      "category-skill-ranks":  "",
    },

    // Migrate old display-name strings (user-typed or pasted) to current names.
    LEGACY_AFFIX_NAME_ALIASES: {
      "elemental damage":      "Elemental Damage (Physical)",
      "specific resistances":  "Specific Resistance (Physical)",
      "skill ranks":           "",
      "specific skill ranks":  "",
      "category skill ranks":  "",
    },
  };
});
