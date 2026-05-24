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
      "Specific Skill Ranks",
      "Category Skill Ranks",
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
      "Specific Skill Ranks",
      "Category Skill Ranks",
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
      "Specific Skill Ranks",
      "Category Skill Ranks",
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
      "Specific Skill Ranks",
      "Category Skill Ranks",
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
      "Specific Skill Ranks",
      "Category Skill Ranks",
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
      "Specific Skill Ranks",
      "Category Skill Ranks",
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
      "Life on Hit",
      "All Resistance",
      "Specific Resistance (Physical)",
      "Specific Resistance (Fire)",
      "Specific Resistance (Cold)",
      "Specific Resistance (Lightning)",
      "Specific Resistance (Poison)",
      "Specific Resistance (Shadow)",
    ]),
    "1H Weapon": Object.freeze([
      "Mainstat",
      "Maximum Life",
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
      "Specific Skill Ranks",
      "Category Skill Ranks",
    ]),
    "2H Weapon": Object.freeze([
      "Mainstat",
      "Maximum Life",
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
      "Specific Skill Ranks",
      "Category Skill Ranks",
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
      "Specific Skill Ranks",
      "Category Skill Ranks",
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
      "Specific Skill Ranks",
      "Category Skill Ranks",
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