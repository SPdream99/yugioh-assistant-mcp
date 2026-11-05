/**
 * What the duel AI knows about a card before it is on the field.
 *
 * Requests from ocgcore carry only passcodes, so without this the policy picks
 * blindly (the old policy ranked cards by passcode). Knowledge is preloaded
 * once per match from cards.cdb and the custom registry, then read
 * synchronously inside the responder.
 */

import { readCardData } from "../card-scripts/card-data.js";
import { listCustomCards } from "../custom-cards/registry.js";
import { typeBits } from "../custom-cards/engine-data.js";

export interface CardRoles {
  search: boolean;
  draw: boolean;
  summon: boolean;
  removal: boolean;
  negate: boolean;
  quick: boolean;
  burn: boolean;
  gyEffect: boolean;
  summonTrigger: boolean;
  flip: boolean;
}

export interface CardKnowledge {
  code: number;
  name: string;
  type: number;
  level: number;
  atk: number;
  def: number;
  desc: string;
  roles: CardRoles;
}

export type KnowledgeLookup = (code: number) => CardKnowledge | undefined;

export const T_MONSTER = 0x1;
export const T_SPELL = 0x2;
export const T_TRAP = 0x4;
export const T_EXTRA = 0x40 | 0x2000 | 0x800000 | 0x4000000;
export const T_QUICKPLAY = 0x10000;
export const T_CONTINUOUS = 0x20000;
export const T_FLIP = 0x200000;

/** Reads the roles a player would infer from the card text. */
export function classifyText(desc: string, type: number): CardRoles {
  const text = desc.toLowerCase();
  const opp = /(your opponent controls|your opponent's|on the field|opponent's (?:field|monster|hand|gy))/;
  return {
    search: /add .{0,80}?from your (deck|gy|graveyard) to your hand/.test(text),
    draw: /\bdraw \d|\bdraw (?:1|2|3) cards?/.test(text),
    summon: /special summon/.test(text),
    removal: /(destroy|banish|return|shuffle|send).{0,60}?/.test(text) && opp.test(text),
    negate: /\bnegate\b/.test(text),
    quick: /quick effect/.test(text) || (type & T_QUICKPLAY) !== 0 || (type & T_TRAP) !== 0,
    burn: /inflict \d+ damage/.test(text),
    gyEffect: /(if|when) this card is (sent|discarded) to the (gy|graveyard)|banish this card from your (gy|graveyard)/.test(text),
    summonTrigger: /(if|when) this card is (normal |special )?(?:or special )?summoned/.test(text),
    flip: /\bflip:/.test(text) || (type & T_FLIP) !== 0
  };
}

/** Preloads knowledge for every code a match can show. Unknown codes are skipped. */
export async function loadCardKnowledge(codes: Iterable<number>): Promise<KnowledgeLookup> {
  const table = new Map<number, CardKnowledge>();
  const customs = new Map<number, ReturnType<typeof listCustomCards>[number]>();
  for (const record of listCustomCards()) {
    customs.set(record.tempId, record);
    if (record.officialId) customs.set(record.officialId, record);
  }

  for (const code of new Set(codes)) {
    if (!code || table.has(code)) continue;
    const custom = customs.get(code);
    if (custom) {
      const type = typeBits(custom.cardData);
      const desc = custom.cardData.desc || "";
      table.set(code, {
        code,
        name: custom.name,
        type,
        level: Number(custom.cardData.level ?? custom.cardData.linkval) || 0,
        atk: Number(custom.cardData.atk) || 0,
        def: Number(custom.cardData.def) || 0,
        desc,
        roles: classifyText(desc, type)
      });
      continue;
    }
    const data = await readCardData(code);
    if (!data) continue;
    table.set(code, {
      code,
      name: data.name,
      type: data.type,
      level: data.level & 0xff,
      atk: data.atk,
      def: data.def,
      desc: data.desc,
      roles: classifyText(data.desc, data.type)
    });
  }
  return (code: number) => table.get(code);
}
