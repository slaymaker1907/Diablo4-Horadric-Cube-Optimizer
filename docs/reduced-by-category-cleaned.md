# Official Blizzard Categories
## Offensive

- Weapon Damage
- Strength
- Intelligence
- Willpower
- Dexterity
- Thorns
- All Damage Multiplier
- Attack Speed
- Critical Strike Chance
- Critical Strike Damage Multiplier
- Vulnerable Damage Multiplier
- Damage Over Time Multiplier
- Cold Damage Multiplier
- Fire Damage Multiplier
- Holy Damage Multiplier
- Lightning Damage Multiplier
- Physical Damage Multiplier
- Poison Damage Multiplier
- Shadow Damage Multiplier

## Defensive

- Maximum Life
- Life Regeneration
- Life On Hit
- Life on Kill
- Armor
- Resistance to All Elements
- Fire Resistance
- Cold Resistance
- Lightning Resistance
- Poison Resistance
- Shadow Resistance
- Physical Resistance
- Damage Reduction
- Dodge Chance

## Utility

- Potion Capacity
- Lucky Hit Chance
- Healing Received
- Barrier Generation
- Fortify Generation
- Cooldown Reduction
- Impairment Reduction
- Skill Category
- Specific Skills

## Resource

- Maximum Resource
- Resource Generation
- Resource On Kill
- Resource Cost Reduction
- Lucky Hit: Up to a 15% Chance to Restore Primary Resource

## Mobility

- Movement Speed
- Attacks Reduce Evade's Cooldown
- Maximum Evade Charge
- Evade Grants Movement Speed

# Cube Categories

‍## Aggressive Tuning Prism

- Mainstat
- Weapon Damage
- Attack Speed
- Critical Strike Chance
- Crititical Strike Damage [x]
- Vulnerable Damage [x]
- DoT Damage [x]
- All Damage [x]
- Elemental Damage [x]
- Thorns

‍## Pragmatic Tuning Prism

- Barrier Generation
- Cooldown Reduction
- Fortify Generation
- Healing Received
- Impairment Reduction
- Life Regeneration
- Lucky Hit Chance
- Movement Speed
- Potion Capacity
- Thorns
- Maximum Evade Charges
- Attacks reduce Evade Cooldown
- Evade grants Movement Speed
‍
## Protector's Tuning Prism

- Armor
- Damage Reduction
- Dodge Chance
- Fortify Generation
- Life on Hit
- Life on Kill
- Life Regeneration
- Maximum Life
- All Resistance
- Specific Resistances

‍## Resourceful Tuning Prism

- Lucky Hit Chance restore Resource
- Maximum Resource
- Resource Cost Reduction
- Resource on Kill
- Resource Regeneration

# Item to Affix Categories

Items can have the following types of affixes on the item type.

| Item | Defensive | Offensive | Resource | Utility | Mobility |
|------|-----------|-----------|----------|---------|----------|
| 1H Weapon | ✗ | ✓ | ✗ | ✗ | ✗ |
| 2H Weapon *(Power increased by 100%)* | ✗ | ✓ | ✗ | ✗ | ✗ |
| Off-Hand | ✓ | ✗ | ✗ | ✓ | ✗ |
| Helm | ✓ | ✗ | ✗ | ✓ | ✗ |
| Chest | ✓ | ✗ | ✗ | ✓ | ✗ |
| Pants | ✓ | ✗ | ✗ | ✓ | ✗ |
| Boots | ✗ | ✗ | ✗ | ✓ | ✓ |
| Gloves | ✗ | ✓ | ✗ | ✓ | ✗ |
| Amulet *(Power increased by 50%)* | ✓ | ✓ | ✓ | ✓ | ✓ |
| Ring | ✗ | ✓ | ✓ | ✗ | ✗ |

# Known Issues

Optimizing endgame items via Horadric Cube crafting requires navigating several hidden rules, hard limitations, and active database bugs. This report compiles all verified mechanics governing Tuning Prisms and affix manipulation as of the latest patch.

---

## Foundational Rules of Affix Manipulation

Before interacting with Tuning Prisms, you must understand two hard-coded systemic rules that dictate how and when an item can be modified.

### 1. The Legendary Lockout Rule
The Cube’s **Remove Affix** recipe is strictly gated by item quality.
* **The Rule:** It only accepts **Magic (Blue)** or **Rare (Yellow)** items.
* **The Constraint:** The exact moment you use an *Add Affix* recipe to push a Rare item to 4 total affixes, the game engine automatically upgrades it to a **Legendary**. Once this happens, the *Remove Affix* function permanently locks out for that item. All base-pool stripping must be completed while the item is still Blue or Yellow.

### 2. The Occultist "Enchant Lock" Exploit
Because the Cube’s prism pools can be volatile, you can use the town Occultist to safely quarantine perfect rolls (like Greater Affixes) from being overwritten.

1. **Identify Target Stat (Pre-crafting):** Isolate the high-value stat or Greater Affix (GA) you want to protect from the Cube's prism pools.
2. **Visit the Occultist (Enchanting):** Take the item to the town Occultist. Pick a completely different, unwanted stat slot and roll it exactly once.
3. **Select No Change (Flagging the item):** When the new stat options appear, select **"Keep Original Reflection"** (No Change). This costs gold/materials but officially flags that specific slot as **Enchanted**.
4. **Craft in the Cube (Safety active):** Take the item back to the Horadric Cube. The Cube's backend code is programmed to completely skip over Enchanted slots. Your protected stat is now safely locked down while you manipulate the other lines.

---

## Active Prism Bucket Bugs & Pool Overlaps

The following table maps the active discrepancies where the game's internal data tables contradict the user interface or logical grouping.

| Affix Target | Intended Prism | Active Behavior / Mechanical Quirks |
| :--- | :--- | :--- |
| **Thorns** | *Varies by Recipe* | **The Complete Asymmetric Loop:** You must use an **Aggressive Tuning Prism** to *Add Affix* it to a blank slot. To use a *Focused Reroll* to optimize its value, you must use a **Protector's Tuning Prism**. To *Remove Affix*, you must use a **Pragmatic Tuning Prism**. |
| **All Resistance** | Chromatic | **The Chromatic Trap:** "Resistance to All Elements" does not live in the Chromatic pool. It is tagged as a pure defense layer. You must use a **Protector's Tuning Prism** to roll or modify it. |
| **Core Stats** *(Str, Int, Dex, Wis)* | Adept | **The Aggressive Pool Bleed:** Because core stats act as damage multipliers, they simultaneously exist in the **Aggressive Tuning Prism** pool. Rolling an Aggressive prism can randomly overwrite your core stat. |

---

## Target-Removing Thorns & Specific Restrictions

Because Thorns functions on a completely split 3-prism asymmetric loop (Add = Aggressive, Reroll = Protector, Remove = Pragmatic), stripping it from an item requires strict execution parameters to avoid bricking the item:

* **The Pragmatic Requirement:** You must possess a **Pragmatic Tuning Prism** (Utility/Mobility) to target Thorns with the *Remove Affix* recipe. No other prism type will recognize it for removal.
* **The Enchant Lock Barrier:** If you previously rolled the Thorns slot at the town Occultist (even if you selected "Keep Original Reflection"), that slot is flagged as **Enchanted**. Because the Cube is hardcoded to skip enchanted lines, the *Remove Affix* recipe will fail to see or target it.
* **The Ghost Seed Loop:** After using a Pragmatic Prism to successfully strip Thorns, **do not immediately execute the "Add Affix" recipe.** If done sequentially in the same UI session, the Cube preserves the item's internal random number generator (RNG) seed. It will almost always roll Thorns immediately back onto the slot at the exact numerical value you just deleted. You must completely close the Horadric Cube interface to flush the backend state machine before adding a new stat.

---

## Mechanical Limits & Reroll Quirks

### 1. Adept’s Prism Skill Rank "Rotation Loop"
When using the **Adept’s Tuning Prism** to hunt for Class Skill Ranks (+Passive or +Core Skills), the system imposes a strict pooling restriction:
* **The Gridlock:** If an item already contains *both* a generic Core Stat and a Class Skill Rank, a Focused Reroll will get stuck in a tight 3-to-4 stat cluster seed, bouncing repeatedly between the same few options.
* **The Hard Ceiling:** The Horadric Cube is hard-coded to reject the addition of *multiple* passive skill ranks onto a single piece of gear via Tuning Prisms. If an item natively has a passive skill rank, you cannot force a second one onto it via the Cube; the recipe will either fail or consume resources without altering the line.

### 2. The "Ghost Seed" Reroll Glitch
A major technical quirk frequently causes the Cube to repeat identical failures during rapid crafting loops.
* **The Phenomenon:** When a Focused Reroll results in the UI error *“This material combo could not change the item's affix,”* players often immediately use *Remove Affix* followed by *Add Affix* to reset the slot.
* **The Trap:** If you execute this sequence rapidly without closing the Cube, the interface preserves the item's internal random number generator (RNG) seed. The *Add Affix* recipe will repeatedly roll the exact same stat and numerical value you just deleted, consuming your Refined Primordial Dust for zero net change.
* **The Fix:** After hitting a recipe error or stripping an affix, you **must completely close out of the Horadric Cube UI**, step your character away from the crafting table, or drop and re-add the item to flush the backend state machine before rolling again.