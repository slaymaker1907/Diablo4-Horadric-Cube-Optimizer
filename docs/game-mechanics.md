# D4 Horadric Cube — Game Mechanics Reference

This document covers only the mechanics that the optimizer models. Transfiguration, item conversion, charm crafting, amalgamation, and rune crafting are out of scope.

## Affix-Modification Operations

The optimizer models four cube operations plus the Enchantress.

| Operation | What happens | Prism |
|---|---|---|
| **Add Affix** | Adds one new affix from any category (or the chosen prism's category). | Optional |
| **Chaotic Reroll** | Removes a random non-enchanted affix and adds a new one from the chosen prism's category. | Optional |
| **Focused Reroll** | The player picks which affix to remove; the new affix comes from the same prism category. | Required |
| **Remove Affix** | Removes a random non-enchanted affix (narrowed to the prism's category if one is used). Not available on Legendary items. | Optional |
| **Enchant** | The Enchantress replaces one chosen affix with any legal affix. One-time use per item. Produces non-GA output unless the affix is kept (same ID). | None |

**Material note:** Add Affix uses Coarse Primordial Dust + Raw Primordial Dust. Chaotic Reroll, Focused Reroll, and Remove Affix use Refined Primordial Dust + Raw Primordial Dust. Exact quantities are not modeled by the optimizer.

---

## Official Affix Categories

Blizzard classifies all affixes into five official categories. These determine which affix types can appear on each gear slot.

| Category | Affixes (representative) |
|---|---|
| **Offensive** | Weapon Damage, Mainstat (Str/Int/Dex/Wis), Thorns, Attack Speed, Critical Strike Chance, Critical Strike Damage, Vulnerable Damage, DoT Damage, All Damage, Elemental Damage (typed) |
| **Defensive** | Maximum Life, Life Regeneration, Life on Hit, Life on Kill, Armor, Resistance to All Elements, Specific Resistances, Damage Reduction, Dodge Chance |
| **Utility** | Potion Capacity, Lucky Hit Chance, Healing Received, Barrier Generation, Fortify Generation, Cooldown Reduction, Impairment Reduction, Skill Category, Specific Skills |
| **Resource** | Maximum Resource, Resource Generation, Resource on Kill, Resource Cost Reduction, Lucky Hit: Restore Primary Resource |
| **Mobility** | Movement Speed, Attacks Reduce Evade Cooldown, Maximum Evade Charges, Evade Grants Movement Speed |

### Item-to-Affix-Category Table

| Item | Defensive | Offensive | Resource | Utility | Mobility |
|---|---|---|---|---|---|
| 1H Weapon | ✗ | ✓ | ✗ | ✗ | ✗ |
| 2H Weapon *(power +100%)* | ✗ | ✓ | ✗ | ✗ | ✗ |
| Off-Hand | ✓ | ✗ | ✗ | ✓ | ✗ |
| Helm | ✓ | ✗ | ✗ | ✓ | ✗ |
| Chest | ✓ | ✗ | ✗ | ✓ | ✗ |
| Pants | ✓ | ✗ | ✗ | ✓ | ✗ |
| Boots | ✗ | ✗ | ✗ | ✓ | ✓ |
| Gloves | ✗ | ✓ | ✗ | ✓ | ✗ |
| Amulet *(power +50%)* | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ring | ✗ | ✓ | ✓ | ✗ | ✗ |

**Note:** Affix availability within each category can vary by character class. The optimizer models shared affixes only; class-specific skill rank affixes may not appear in the optimizer's pool.

---

## Tuning Prisms

Prisms steer random outcomes toward a specific affix category. An affix belongs to the prism category that governs its default cube interactions. Some affixes use **different prisms per operation** — see [Known Mechanical Edge Cases](#known-mechanical-edge-cases) below.

| Prism | Affix Category |
|---|---|
| **Aggressive** | Mainstat, Weapon Damage, Attack Speed, Critical Strike Chance, Critical Strike Damage, Vulnerable Damage, DoT Damage, All Damage, Elemental Damage (typed), Thorns *(Add only — see edge cases)* |
| **Pragmatic** | Barrier Generation, Cooldown Reduction, Fortify Generation, Healing Received, Impairment Reduction, Life Regeneration, Lucky Hit Chance, Movement Speed, Potion Capacity, Maximum Evade Charges, Attacks reduce Evade Cooldown, Evade grants Movement Speed, Thorns *(Remove only — see edge cases)* |
| **Protector** | Armor, Damage Reduction, Dodge Chance, Fortify Generation, Life on Hit, Life on Kill, Life Regeneration, Maximum Life, All Resistance, Specific Resistance (typed), Thorns *(Focused/Chaotic Reroll only — see edge cases)* |
| **Resourceful** | Lucky Hit Chance restore Resource, Maximum Resource, Resource Cost Reduction, Resource on Kill, Resource Regeneration |
| **Adept** | Mainstat, Specific Skill Ranks (individual class skills). "Category Skill Ranks" (+X to All [Class] Skills) is in the Adept pool conceptually but is **enchant-only** — see edge cases. |
| **Chromatic** | Specific Resistance (typed) |

For Focused Reroll, a prism is always required.

---

## Greater Affixes (GAs)

- GAs can **never be acquired** through cube or Enchantress operations — only preserved.
- Any cube operation that touches an affix (including Focused Reroll on that affix's slot) produces a **non-GA** result for the new affix.
- Enchanting to a **different** affix always produces non-GA. Enchanting to the **same** affix (keeping it) preserves GA status.
- The optimizer treats GA preservation as always-on: any GA on a current affix that maps to a target affix is implicitly protected. The optimizer will not recommend actions that risk losing it.

---

## Focused Reroll Eligibility

When a Focused Reroll uses a given prism, it randomly selects from **all non-enchanted affixes on the item that belong to that prism's category** — not just the one the player intends to change. If a protected GA affix shares the prism category, the optimizer will refuse to recommend a Focused Reroll with that prism, because the GA affix could be randomly selected and lost.

---

## Enchantress

- Each item has one Enchantress use. Once spent, it cannot be reused unless the enchanted affix is removed by the cube.
- The Enchantress can change any non-locked affix to any other legal affix for that item's slot.
- The enchanted affix is immune to cube operations (it cannot be randomly selected for removal or reroll).
- After an enchanted affix is removed (by a cube remove operation), the Enchantress becomes available again.

---

## Known Mechanical Edge Cases

The following quirks deviate from straightforward prism categorization. The optimizer models all of them.

### 1. Thorns — The Asymmetric 3-Prism Loop

Thorns is the only affix that requires a **different prism for each operation type**:

| Operation | Required Prism | Notes |
|---|---|---|
| Add Affix | **Aggressive** | Thorns is added from the Aggressive pool |
| Focused Reroll | **Protector** | Must use Protector to target and optimize the Thorns slot |
| Chaotic Reroll | **Protector** | Must use Protector for the chaotic roll to include Thorns |
| Remove Affix | **Pragmatic** | Must use Pragmatic to target Thorns for removal |

Using the wrong prism for an operation will not target Thorns. Additionally:
- If Thorns was previously Enchant-locked (even with "Keep Original"), the Remove Affix recipe cannot see or target it.
- After using Pragmatic to strip Thorns, close the Cube UI completely before adding a new affix. Executing Add in the same session may re-roll Thorns back (Ghost Seed Loop).

### 2. All Resistance — The Chromatic Trap

"Resistance to All Elements" is **not** in the Chromatic prism pool despite the name suggesting it. It is a pure defense layer and requires a **Protector's Tuning Prism** to roll or modify. Chromatic only covers typed (element-specific) resistances.

### 3. Core Stats — The Aggressive Pool Bleed

Core stats (Strength, Intelligence, Dexterity, Willpower/Wisdom) act as damage multipliers and simultaneously exist in the **Aggressive Tuning Prism** pool. Rolling an Aggressive prism can randomly overwrite a core stat slot. Plan accordingly when a core stat is on the item.

### 4. The Legendary Lockout

The cube's **Remove Affix** recipe accepts only Magic (Blue) or Rare (Yellow) items. The moment an Add Affix recipe pushes a Rare item to 4 total affixes, the game engine automatically upgrades it to Legendary and permanently locks out Remove Affix for that item. All base-pool stripping must be completed while the item is still Blue or Yellow.

### 5. The Enchant Lock

The Cube skips enchanted slots entirely. To protect a high-value roll (such as a Greater Affix) from being overwritten by a prism pool, enchant a different, unwanted slot at the Occultist and select "Keep Original Reflection" (No Change). That slot is flagged Enchanted and will be bypassed by all subsequent Cube operations.

### 6. The Ghost Seed Loop

After using a Focused Reroll or Remove Affix recipe that results in a UI error ("This material combo could not change the item's affix"), or after stripping an affix you plan to replace, **close the Horadric Cube UI completely** before rolling again. The Cube preserves the item's internal RNG seed within a single UI session. Rapid Remove → Add sequences will repeatedly roll the exact same stat at the exact same numerical value, consuming Refined Primordial Dust for no net change.

### 7. Category Skill Ranks — Enchant Only

"+X to All [Class] Skills" (**Category Skill Ranks** in the optimizer) exists in the gear pool and can appear as an Enchantress target, but it **cannot** be rolled, rerolled, or removed via any Horadric Cube recipe. It is conceptually in the Adept prism pool but has empty operation categories for Add, Focused Reroll, Chaotic Reroll, and Remove — so no cube prism can touch it. The only way to acquire or change this affix is via the Enchantress.
