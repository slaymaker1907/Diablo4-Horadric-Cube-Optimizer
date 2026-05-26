# Gear Slot → Affix Legality

**Data source:** Diablo4Companion (josdemmers/Diablo4Companion), cross-referenced against
D4 game knowledge.

**Regenerate:** `node scripts/build-slot-legality.js`
(inputs are snapshotted in `scripts/data/`; refresh them from Companion's GitHub before
re-running after major D4 patches).

**Merge policy:** new table = UNION(current table, Companion-derived additions).
Affixes are never auto-removed; consult `scripts/data/slot-legality.diff.md` after a
re-run to review any additions or warnings.

Skill rank affixes (`to Bash`, `to All Skills`, etc.) and skill multiplier affixes
(`Basic Skill Damage Multiplier`, etc.) are appended to each slot's list at runtime
via `ALL_SKILL_RANK_NAMES` and `SKILL_MULTIPLIER_NAMES` in `gear-slot-legality.js`;
they are not enumerated again below.

---

## Helm

- Mainstat
- Maximum Life
- Armor
- Cooldown Reduction
- Maximum Resource
- Life on Hit
- Life on Kill
- Life Regeneration
- Barrier Generation
- Fortify Generation
- Healing Received
- Impairment Reduction
- All Resistance
- Specific Resistance (Physical)
- Specific Resistance (Fire)
- Specific Resistance (Cold)
- Specific Resistance (Lightning)
- Specific Resistance (Poison)
- Specific Resistance (Shadow)

## Chest

- Mainstat
- Maximum Life
- Armor
- Damage Reduction
- Thorns
- Life Regeneration
- Barrier Generation
- Fortify Generation
- Healing Received
- All Resistance
- Specific Resistance (Physical)
- Specific Resistance (Fire)
- Specific Resistance (Cold)
- Specific Resistance (Lightning)
- Specific Resistance (Poison)
- Specific Resistance (Shadow)

## Gloves

- Mainstat
- Maximum Life
- Armor
- Attack Speed
- Critical Strike Chance
- Critical Strike Damage
- Lucky Hit Chance
- Lucky Hit Chance restore Resource
- Life on Hit
- (+ skill multiplier names)

## Pants

- Mainstat
- Maximum Life
- Armor
- Damage Reduction
- Dodge Chance
- Thorns
- Potion Capacity
- Impairment Reduction
- Life Regeneration
- Barrier Generation
- Fortify Generation
- Healing Received
- All Resistance
- Specific Resistance (Physical)
- Specific Resistance (Fire)
- Specific Resistance (Cold)
- Specific Resistance (Lightning)
- Specific Resistance (Poison)
- Specific Resistance (Shadow)

## Boots

- Mainstat
- Maximum Life
- Armor
- Movement Speed
- Dodge Chance
- Impairment Reduction
- Life Regeneration
- Fortify Generation
- Healing Received
- Maximum Evade Charges
- Attacks reduce Evade Cooldown
- Evade grants Movement Speed
- All Resistance
- Specific Resistance (Physical)
- Specific Resistance (Fire)
- Specific Resistance (Cold)
- Specific Resistance (Lightning)
- Specific Resistance (Poison)
- Specific Resistance (Shadow)

## Amulet

- Mainstat
- Maximum Life
- All Damage
- Attack Speed
- Critical Strike Chance
- Cooldown Reduction
- Movement Speed
- Damage Reduction
- Impairment Reduction
- Resource Cost Reduction
- Elemental Damage (Physical)
- Elemental Damage (Fire)
- Elemental Damage (Cold)
- Elemental Damage (Lightning)
- Elemental Damage (Poison)
- Elemental Damage (Shadow)
- All Resistance
- (+ skill multiplier names)

## Ring

- Mainstat
- Maximum Life
- Attack Speed
- Critical Strike Chance
- Critical Strike Damage
- Vulnerable Damage
- DoT Damage
- Lucky Hit Chance
- Maximum Resource
- Resource Regeneration
- Life on Hit
- All Resistance
- Specific Resistance (Physical)
- Specific Resistance (Fire)
- Specific Resistance (Cold)
- Specific Resistance (Lightning)
- Specific Resistance (Poison)
- Specific Resistance (Shadow)
- (+ skill multiplier names)

## 1H Weapon

- Mainstat
- Maximum Life
- **Maximum Resource** ← added (e.g. Maximum Fury for Barbarian dual-wield)
- Weapon Damage
- All Damage
- Attack Speed
- Critical Strike Damage
- Vulnerable Damage
- DoT Damage
- Elemental Damage (Physical)
- Elemental Damage (Fire)
- Elemental Damage (Cold)
- Elemental Damage (Lightning)
- Elemental Damage (Poison)
- Elemental Damage (Shadow)
- Life on Hit
- Life on Kill
- Resource on Kill
- (+ skill multiplier names)

## 2H Weapon

- Mainstat
- Maximum Life
- **Maximum Resource** ← added (e.g. Maximum Fury for Barbarian 2H builds)
- Weapon Damage
- All Damage
- Attack Speed
- Critical Strike Damage
- Vulnerable Damage
- DoT Damage
- Elemental Damage (Physical)
- Elemental Damage (Fire)
- Elemental Damage (Cold)
- Elemental Damage (Lightning)
- Elemental Damage (Poison)
- Elemental Damage (Shadow)
- Life on Hit
- Life on Kill
- Resource on Kill
- (+ skill multiplier names)

## Offhand

- Mainstat
- Maximum Life
- Cooldown Reduction
- Critical Strike Chance
- Lucky Hit Chance
- Lucky Hit Chance restore Resource
- Maximum Resource
- Resource Cost Reduction
- Resource Regeneration

## Shield

- Mainstat
- Maximum Life
- Armor
- Damage Reduction
- Thorns
- Cooldown Reduction
- Critical Strike Chance
- Lucky Hit Chance
- Lucky Hit Chance restore Resource
- Resource Cost Reduction
- All Resistance
