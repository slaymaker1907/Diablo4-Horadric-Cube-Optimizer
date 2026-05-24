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

## Tuning Prisms

Prisms steer random outcomes toward a specific affix category. An affix can belong to more than one category (e.g. Thorns is both Aggressive and Pragmatic; Fortify Generation is both Pragmatic and Protector). For Focused Reroll, a prism is required.

| Prism | Affix Category |
|---|---|
| **Aggressive** | Mainstat, Weapon Damage, Attack Speed, Critical Strike Chance, Critical Strike Damage, Vulnerable Damage, DoT Damage, All Damage, Elemental Damage (typed), Thorns |
| **Pragmatic** | Barrier Generation, Cooldown Reduction, Fortify Generation, Healing Received, Impairment Reduction, Life Regeneration, Lucky Hit Chance, Movement Speed, Potion Capacity, Thorns, Maximum Evade Charges, Attacks reduce Evade Cooldown, Evade grants Movement Speed |
| **Protector** | Armor, Damage Reduction, Dodge Chance, Fortify Generation, Life on Hit, Life on Kill, Life Regeneration, Maximum Life, All Resistance, Specific Resistance (typed) |
| **Resourceful** | Lucky Hit Chance restore Resource, Maximum Resource, Resource Cost Reduction, Resource on Kill, Resource Regeneration |
| **Adept** | Mainstat, Skill Ranks |
| **Chromatic** | Specific Resistance (typed) |

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
