# Latent Legends rules

The exact rules the engine (`engine/rules.js`) implements. Numbers live in `data/cards.json` and in `DEFAULTS` in the engine.

## Board and goal
- Two players, three lanes. In every lane each player has one Front slot, one Back slot and a Shrine. Shrines have 9 HP; the second player's have 10.
- Destroy two enemy Shrines to win. If neither player has done so after both have played 16 turns, the higher total Shrine HP wins; equal totals are a draw.
- When a Shrine falls, its lane closes for both players (see Closed lanes).
- Tank, Fighter and Crystal Wall go in Front slots; Mage, Archer and Support go in Back slots.

## Resources
- **Essence** pays for cards. On your n-th turn you get min(n, 8). Unspent Essence is lost.
- **Mana** belongs to each character and pays only for its Skill. A character enters with its Start Mana and gains +1 at each of its owner's Starts, up to Max Mana. A +1 into a full bar is wasted. Skills spend their cost; Blast spends all Mana.

## Deck and hand
- 20 cards, at most 2 copies of a card, at most 2 elements plus neutral cards, at most 2 Jokers (one copy each).
- Opening hand 4 cards; the second player draws 5 and also gets a Spark. Draw 1 card each Start. Hand limit 7: a card drawn into a full hand is discarded. An empty deck draws nothing.
- There is no mulligan.

## Turn
1. **Start:** gain Essence, draw, Burn ticks, every character you control gains +1 Mana and becomes ready, your Taunts end.
2. **Main:** play cards in any order. Once per turn you may pay 1 Essence to move a character to the same row of an adjacent open lane, if that slot is empty; it keeps its Mana but does not act this turn.
3. **Combat:** your ready characters act in order: lane 1 to 3, Front before Back. Each does exactly one thing: Attack or Skill. A character played or moved this turn is not ready. A Frozen character skips this action and thaws.
4. **End:** the turn passes.

## Damage
- Damage = power + element - defence, minimum 1. Physical damage is reduced by Armor, magic damage by Ward. Pure damage (Burn, Thorns) ignores both and the element.
- Element: +1 if the source's element beats the target's, -1 if the target's beats the source's. Fire beats Wild and Frost; Wild beats Storm and Shadow; Storm beats Frost and Fire; Frost beats Shadow and Wild; Shadow beats Fire and Storm.
- Shrines have no defence and no element: they take the full ATK. Skills and spells never hit Shrines.
- Healing never goes above max HP. A character at 0 HP dies at once; its card goes to its owner's graveyard.
- There is no counterattack.

## Attack
- Physical, ATK damage, to the enemy Front unit in the same lane; if there is none, to the enemy Shrine in that lane.
- Back units attack by the same rule. Only Skills and spells reach Back slots.

## Skills
- **Taunt (Tank, 2):** until your next Start, enemy Dive, Snipe and Siphon in this lane must target this unit.
- **Dive (Fighter, 2):** physical damage to the enemy Back unit in this lane, or to the Front unit if the Back slot is empty; redirected by Taunt.
- **Blast (Mage, X):** spend all Mana (at least 1); that much magic damage to every enemy unit in this lane. Ignores Taunt.
- **Snipe (Archer, 2):** physical damage (one more than the Archer's ATK from cost 2 up) to any enemy unit in this lane; redirected by Taunt.
- **Siphon (Support, 2):** magic damage to an enemy unit in this lane, and heal your Front unit in this lane. The Support never heals itself.

## Spells
Spell damage is magic and uses the spell's element.
- Fireball (Fire, 3): 3 to any enemy unit.
- Lava Pool (Fire, 2): enemy units in a lane get Burn 2 (1 pure damage at each of their owner's next 2 Starts).
- Thorns (Wild, 1): an ally gains Thorns 1 (each Attack against it deals 1 pure back).
- Regrowth (Wild, 2): heal an ally 1, then +1 ATK and +1 max HP.
- Chain Lightning (Storm, 3): 2 to an enemy unit; if it dies, 2 to an enemy unit in an adjacent lane (Front first).
- Gust (Storm, 4): push an enemy unit to the same row of an adjacent open lane, if empty.
- Frost Nova (Frost, 3): freeze every enemy unit in a lane.
- Crystal Wall (Frost, 1): summon a 0/4 Armor 1 Wall in your empty Front slot. It never acts.
- Void Bolt (Shadow, 2): 2 to an enemy unit; heal your unit in that lane (Front first) by the damage dealt.
- Gravity Well (Shadow, 3): swap the enemy Front and Back units in a lane, then 1 magic to both.

## Closed lanes
- When a Shrine falls and the match is not over, its lane closes for both players for the rest of the match.
- Every unit in that lane leaves at once: first the units of the player whose Shrine fell, then the other player's, Front before Back.
- Each goes to a free slot of its own row (Front for Tank, Fighter and Wall, Back for the rest) in an open lane on its side. The nearest lane comes first; of two equally near lanes, the lower one.
- A unit that moves this way keeps its damage, Mana and statuses, except Burn, which ends because Lava Pool belongs to the lane. Like a moved unit, it does not act this turn.
- If no slot is free, the unit goes back to its owner's hand as its card, so its damage, Mana and statuses are gone (a Mimic copy comes back as the card it copied). If the hand is full (7 cards), the unit is lost and its card goes to the graveyard. A Crystal Wall never goes to hand: it is removed.
- Nothing enters a closed lane: no summons, moves, pushes, spells, Skills or lane spells. The other Shrine there stays standing, can never be hit, and still counts at the turn limit.

## Jokers (neutral)
- Spark (0): +1 Essence this turn.
- Mirror (2): change an ally's element for the rest of the match.
- Swap (0): swap two of your units in the same row across lanes.
- Mimic (2): summon a -1/-1 copy (minimum 1) of the last character either player played.
- Rebirth (2): return your most expensive fallen character to your hand.

## Options (off by default, for experiments)
- `terrain: 'atk' | 'mana'`: each lane gets a random element; that element's units get +1 ATK there, or enter with +1 Mana.
- `comeback: true`: when one of your Shrines falls, your characters gain +1 Mana.
- `p1ShrineBonus` (default 1), `secondPlayerSparks` (default 1), `diveFallback` (default on): the second player's extra Shrine HP, the second player's Spark, and Dive hitting the Front unit when the Back slot is empty.
- `noSpells`, `noElements`: diagnostics only, used to find where an imbalance comes from.
