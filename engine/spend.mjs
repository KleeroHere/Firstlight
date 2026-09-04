// Счётчик расходов на Gemini Image с жёстким потолком.
//
// Заведён 30.08.2026: владелец кладёт на API фиксированную сумму и не хочет
// узнавать о перерасходе постфактум. Раньше единственной защитой была
// оценка «$0.48 за ролик», напечатанная перед запуском, — а на волне 4
// сгорело ~$40, потому что никто не считал сумму по всем прогонам.
//
// Книга расходов: reports/gemini-spend.json. Потолок хранится там же и
// живёт между запусками — скрипты его не понижают и не повышают сами.
//
//   import { price, ledger } from "./spend.mjs";
//   const led = ledger();                  // читает книгу
//   led.check(price("1K"));                // бросит, если не влезает
//   led.charge("flf_keys", id, "1K");      // записывает факт
//
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "./lib.mjs";

// Цены Gemini 3.1 Flash Image за одну выданную картинку (август 2026).
// Входная картинка (мастер) стоит ~1120 токенов — доли цента, в расчёт не
// берём, но потолок задан с запасом именно на такую мелочь.
const PRICES = { "0.5K": 0.045, "1K": 0.067, "2K": 0.101, "4K": 0.15 };
const DEFAULT_LIMIT_USD = 21.5; // ≈ 20 € по курсу конца августа 2026

const FILE = join(ROOT, "reports", "gemini-spend.json");

export function price(size) {
  const p = PRICES[size];
  if (p == null) throw new Error(`Неизвестный размер картинки: ${size}`);
  return p;
}

export class BudgetExceeded extends Error {}

export function ledger() {
  let data = { limit_usd: DEFAULT_LIMIT_USD, spent_usd: 0, runs: [] };
  if (existsSync(FILE)) data = { ...data, ...JSON.parse(readFileSync(FILE, "utf8")) };

  const save = () => {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
  };

  return {
    get spent() { return data.spent_usd; },
    get limit() { return data.limit_usd; },
    get left() { return data.limit_usd - data.spent_usd; },

    /** Бросает BudgetExceeded, если следующая картинка не влезает в потолок. */
    check(cost) {
      if (data.spent_usd + cost > data.limit_usd) {
        throw new BudgetExceeded(
          `потолок расходов исчерпан: потрачено $${data.spent_usd.toFixed(2)} ` +
          `из $${data.limit_usd.toFixed(2)}, следующая картинка стоит ` +
          `$${cost.toFixed(3)}. Потолок правится в ${FILE} (поле limit_usd).`);
      }
    },

    /** Записывает факт выдачи картинки. */
    charge(script, id, size, n = 1) {
      const cost = price(size) * n;
      data.spent_usd = Number((data.spent_usd + cost).toFixed(4));
      const today = new Date().toISOString().slice(0, 10);
      const last = data.runs[data.runs.length - 1];
      if (last && last.date === today && last.script === script && last.id === id && last.size === size) {
        last.images += n;
        last.usd = Number((last.usd + cost).toFixed(4));
      } else {
        data.runs.push({ date: today, script, id, size, images: n, usd: Number(cost.toFixed(4)) });
      }
      save();
      return cost;
    },

    line() {
      return `бюджет: потрачено $${data.spent_usd.toFixed(2)} из ` +
        `$${data.limit_usd.toFixed(2)}, осталось $${this.left.toFixed(2)}`;
    },
  };
}
