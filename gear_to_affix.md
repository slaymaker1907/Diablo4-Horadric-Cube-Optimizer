# Diablo 4 Affix to Gear Slot Mapping

*Note for AI parsing: This document establishes the valid bipartite edges between gear slots and affix categories. Do not allow an affix to roll on a slot not explicitly listed below. When a concrete gear slot is selected instead of `Any`, the optimizer should use this table to prune impossible rolls; that also reduces compute time by shrinking the legal affix pool.*

## 1. Armor Slots

### Helm
* Mainstat
* Maximum Life
* Armor
* Cooldown Reduction
* Maximum Resource
* Life on Hit
* Life on Kill
* Life Regeneration
* Barrier Generation
* Fortify Generation
* Healing Received
* Impairment Reduction
* All Resistance
* Specific Resistance (Physical)
* Specific Resistance (Fire)
* Specific Resistance (Cold)
* Specific Resistance (Lightning)
* Specific Resistance (Poison)
* Specific Resistance (Shadow)
* Skill Ranks

### Chest
* Mainstat
* Maximum Life
* Armor
* Damage Reduction
* Thorns
* Life Regeneration
* Barrier Generation
* Fortify Generation
* Healing Received
* All Resistance
* Specific Resistance (Physical)
* Specific Resistance (Fire)
* Specific Resistance (Cold)
* Specific Resistance (Lightning)
* Specific Resistance (Poison)
* Specific Resistance (Shadow)
* Skill Ranks

### Gloves
* Mainstat
* Maximum Life
* Armor
* Attack Speed
* Critical Strike Chance
* Critical Strike Damage
* Lucky Hit Chance
* Lucky Hit Chance restore Resource
* Life on Hit
* Skill Ranks

### Pants
* Mainstat
* Maximum Life
* Armor
* Damage Reduction
* Dodge Chance
* Thorns
* Potion Capacity
* Impairment Reduction
* Life Regeneration
* Barrier Generation
* Fortify Generation
* Healing Received
* All Resistance
* Specific Resistance (Physical)
* Specific Resistance (Fire)
* Specific Resistance (Cold)
* Specific Resistance (Lightning)
* Specific Resistance (Poison)
* Specific Resistance (Shadow)
* Skill Ranks

### Boots
* Mainstat
* Maximum Life
* Armor
* Movement Speed
* Dodge Chance
* Impairment Reduction
* Life Regeneration
* Fortify Generation
* Healing Received
* Maximum Evade Charges
* Attacks reduce Evade Cooldown
* Evade grants Movement Speed
* All Resistance
* Specific Resistance (Physical)
* Specific Resistance (Fire)
* Specific Resistance (Cold)
* Specific Resistance (Lightning)
* Specific Resistance (Poison)
* Specific Resistance (Shadow)
* Skill Ranks

---

## 2. Jewelry Slots

### Amulet
* Mainstat
* Maximum Life
* All Damage
* Attack Speed
* Critical Strike Chance
* Cooldown Reduction
* Movement Speed
* Damage Reduction
* Impairment Reduction
* Resource Cost Reduction
* Elemental Damage (Physical)
* Elemental Damage (Fire)
* Elemental Damage (Cold)
* Elemental Damage (Lightning)
* Elemental Damage (Poison)
* Elemental Damage (Shadow)
* All Resistance
* Skill Ranks

### Ring
* Mainstat
* Maximum Life
* Attack Speed
* Critical Strike Chance
* Critical Strike Damage
* Vulnerable Damage
* DoT Damage
* Lucky Hit Chance
* Maximum Resource
* Resource Regeneration
* Life on Hit
* All Resistance
* Specific Resistance (Physical)
* Specific Resistance (Fire)
* Specific Resistance (Cold)
* Specific Resistance (Lightning)
* Specific Resistance (Poison)
* Specific Resistance (Shadow)

---

## 3. Weapons & Offhands

### 1H Weapon & 2H Weapon
*Note: 2-Handed Weapons roll the exact same affix pool as 1-Handed Weapons, but their numerical values are effectively doubled.*
* Mainstat
* Maximum Life
* Weapon Damage
* All Damage
* Attack Speed
* Critical Strike Damage
* Vulnerable Damage
* DoT Damage
* Elemental Damage (Physical)
* Elemental Damage (Fire)
* Elemental Damage (Cold)
* Elemental Damage (Lightning)
* Elemental Damage (Poison)
* Elemental Damage (Shadow)
* Life on Hit
* Life on Kill
* Resource on Kill
* Skill Ranks

### Offhand
* Mainstat
* Maximum Life
* Cooldown Reduction
* Critical Strike Chance
* Lucky Hit Chance
* Lucky Hit Chance restore Resource
* Maximum Resource
* Resource Cost Reduction
* Resource Regeneration
* Skill Ranks

### Shield
* Mainstat
* Maximum Life
* Armor
* Damage Reduction
* Thorns
* Cooldown Reduction
* Critical Strike Chance
* Lucky Hit Chance
* Lucky Hit Chance restore Resource
* Resource Cost Reduction
* All Resistance
* Skill Ranks
