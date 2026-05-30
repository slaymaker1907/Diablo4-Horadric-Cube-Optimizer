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
| **Enchant** | The Enchantress replaces one chosen affix with any legal affix that does not duplicate another slot. The targeted slot becomes the item's sticky enchanted slot and can be re-enchanted any number of times (but no other slot can ever be enchanted afterward). Produces non-GA output when the affix changes; same-affix keeps GA (Phase-1 mark). Re-enchanting an enchanted+GA slot is disallowed. | None |

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
| **Aggressive** | Mainstat, Weapon Damage, Attack Speed, Critical Strike Chance, Critical Strike Damage, Vulnerable Damage, DoT Damage, All Damage, Elemental Damage (typed), Skill Multipliers (family — Basic/Core/Backstab Skill Damage Multiplier), Thorns *(Add only — see edge cases)* |
| **Pragmatic** | Barrier Generation, Cooldown Reduction, Fortify Generation, Healing Received, Impairment Reduction, Life Regeneration, Lucky Hit Chance, Movement Speed, Potion Capacity, Maximum Evade Charges, Attacks reduce Evade Cooldown, Evade grants Movement Speed, Thorns *(Remove only — see edge cases)* |
| **Protector** | Armor, Damage Reduction, Dodge Chance, Fortify Generation, Life on Hit, Life on Kill, Life Regeneration, Maximum Life, All Resistance, Specific Resistance (typed), Thorns *(Focused/Chaotic Reroll only — see edge cases)* |
| **Resourceful** | Lucky Hit Chance restore Resource, Maximum Resource, Resource Cost Reduction, Resource on Kill, Resource Regeneration |
| **Adept** | Mainstat; class-agnostic general skills *(family — to Basic / Core / Defensive Skills)*; class-specific general skills *(family, filtered by class — e.g. to Brawling / Wrath / Conjuration Skills)*; specific class skills *(family, filtered by class — e.g. to Bash, to Claw, to Fireball)*; to All Skills *(enchant-only, see edge case 7)*. |
| **Chromatic** | Specific Resistance (typed) |

For Focused Reroll, a prism is always required.

### Family-Level Rolling

Some affixes are grouped into a **family** that rolls as a single logical entry within its prism category. When the catalog entry carries a `familyRollWeight`, the family contributes that weight at the prism level (once, regardless of how many members are present), and each member is rolled with equal probability within the family. Effective per-member weight is `familyRollWeight / count-of-family-members-in-pool`, so class and slot narrowing automatically renormalize the family.

Families with this treatment:

- **Skill Multipliers** (Aggressive): Basic / Core / Backstab Skill Damage Multiplier.
- **Class-Agnostic General Skills** (Adept): to Basic / Core / Defensive Skills.
- **Class-Specific General Skills** (Adept): per-class buckets like to Brawling Skills, to Wrath Skills, to Conjuration Skills. Filtered by class.
- **Specific Skills** (Adept): per-class single-skill ranks like to Bash, to Claw, to Fireball. Filtered by class.

Families *without* `familyRollWeight` keep their per-subtype weighting — Elemental Damage (typed) and Specific Resistance (typed) currently behave this way, so each typed subtype rolls independently at weight 1.

### Class Scope

`state.class` narrows the Adept pool to a single character class. When set, only skill affixes whose `class` field is empty (class-agnostic — Mainstat, to All Skills, to Basic / Core / Defensive Skills) or matches the chosen class remain in the rolling pool. `Any` keeps every class's skills in the pool — useful for browsing, but the resulting per-skill probabilities are much smaller than what a real character would experience.

### Learned Roll Weights (Outcome Tracking)

The base weights above are all `1`. The actual in-game roll weights are learned from recorded reroll outcomes. Turn on **Settings → Developer → Track reroll outcomes** and the app logs each applied Add / Focused / Chaotic / Remove / Enchant result, together with the item state *before* the reroll, to `localStorage` (separate from Copy Config, persisted across reloads, discarded when `MODEL_VERSION` changes). **Export Tracking Data** produces a JSON for `scripts/learn-weights-from-tracking.js`, which patches `config.LEARNED_WEIGHTS` (overlaid onto the catalog in `buildAffixCatalog`) and bumps `MODEL_VERSION`.

The estimator (in the shared `weight-tracking.js` module) is the **Plackett–Luce / conditional-logit** model — a single reroll is a categorical draw over the eligible pool `S_t`, and that pool changes per draw, so the textbook Dirichlet update would be biased. It is fit by the MM/Zermelo iteration

```
W_u ← (a_u − 1 + wins_u) / (b_u + exposure_u),   exposure_u = Σ_{t: u∈S_t} 1 / (Σ_{v∈S_t} W_v)
```

with a weak **Gamma prior** anchored at the present baseline: `b_u = κ`, `a_u − 1 = κ·W⁰_u` (so the prior mode is `W⁰_u`), default `κ = 0.5`. `wins_u` is how often unit `u` came out; `exposure_u` is its total "1 / pool-weight" over every draw where it was eligible — i.e. learned weight ≈ wins-per-eligible-exposure, which corrects the per-draw pool censoring. Computed under the fixed baseline these statistics are additive, so the browser keeps a live one-shot estimate and merges trivially; the Node script can also iterate to convergence over the raw rows. Only **Add / Focused / Chaotic** inform weights; Remove (uniform) and Enchant (deterministic) are logged but uninformative.

A **learning unit** carries one tied weight: a singleton affix (its `rollWeight`); a `familyRollWeight` family — skills and skill-multipliers, **pooled across classes** (the family total); or a tied-subtype family — Elemental Damage / Specific Resistance — as one shared per-member weight (the family total split evenly, so "fire is as likely as physical" is preserved while the family's overall propensity is learned). Only skills differ between classes, matching the catalog (only skill entries carry a `class`). The learned scale is irrelevant — the solver normalizes per pool — so only the relative weights matter.

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

- Each item has at most one **enchanted slot**, and it is **sticky**: once any slot becomes enchanted on an item, that slot is the enchanted slot for the rest of the item's life. The Enchantress cannot mark a different slot as enchanted afterward.
- The enchanted slot can be re-enchanted any number of times, but **only the enchanted slot** is a legal source for further enchant operations once one exists.
- Re-enchanting a slot whose current affix is GA is **forbidden**: same-affix re-enchant is a no-op, and changing the affix would destroy the GA (GAs can never be acquired through any operation — only preserved).
- Each enchant chooses a target affix. If the target equals the slot's current affix, the slot is just marked enchanted (Phase 1 only — preserves GA, locks the slot from cube ops). If the target differs, the slot's affix is replaced with the new one and `isGA` is forced to `false`.
- The new affix can never duplicate another slot's `affixId` on the same item.
- The enchanted slot is immune to cube operations: focused reroll, chaotic reroll, and remove all skip it.
- There is no per-item cap on enchant uses; the slot-state encoding above fully determines availability, and the old `enchantressAvailable` flag has been removed from the worker state model.

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

### 7. to All Skills — Enchant Only

`to All Skills` is the lone enchant-only skill affix. It exists in the gear pool and can appear as an Enchantress target, but it **cannot** be rolled, rerolled, or removed via any Horadric Cube recipe. It is conceptually in the Adept prism pool but has empty operation categories for Add, Focused Reroll, Chaotic Reroll, and Remove — so no cube prism can touch it. The only way to acquire or change this affix is via the Enchantress.

The per-category general skill ranks — `to Brawling Skills`, `to Wrath Skills`, `to Basic Skills`, etc. — are **not** enchant-only. They are ordinary Adept-prism entries that can be added, focused-rerolled, chaotic-rerolled, and removed like any other affix, subject to family-level rolling and class scope.
