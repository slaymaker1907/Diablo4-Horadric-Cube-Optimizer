(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  }
  root.d4cubeoptimConfig = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  return {
    DAMAGE_TYPES: ["Physical", "Fire", "Cold", "Shadow", "Lightning", "Poison"],

    // Affix names per prism category.
    // "Elemental Damage" and "Specific Resistance" are sentinel strings: the HTML
    // expands them into per-element typed-affix objects using DAMAGE_TYPES.
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
        "Specific Skill Ranks",
        "Category Skill Ranks",
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
      "Category Skill Ranks": {
        add:     [],
        focused: [],
        chaotic: [],
        remove:  [],
      },
    },

    // Migrate old affix IDs (localStorage / URL) to current canonical IDs.
    LEGACY_AFFIX_ID_MAP: {
      "elemental-damage":      "elemental-damage-physical",
      "specific-resistances":  "specific-resistance-physical",
      "skill-ranks":           "specific-skill-ranks",
    },

    // Migrate old display-name strings (user-typed or pasted) to current names.
    LEGACY_AFFIX_NAME_ALIASES: {
      "elemental damage":      "Elemental Damage (Physical)",
      "specific resistances":  "Specific Resistance (Physical)",
      "skill ranks":           "Specific Skill Ranks",
    },
  };
});
