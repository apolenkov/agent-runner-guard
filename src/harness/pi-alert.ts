/**
 * Расширение Pi для сторожа запусков: `pi -e <этот файл> -p …` (добавляет
 * хук `wrap-runner-command.ts`). Когда Pi сдался с ошибкой (свои ретраи
 * исчерпаны), дописывает одну JSON-строку в $HARNESS_ALERT_FILE: `rate_limit`
 * при признаке лимита в тексте ошибки, иначе `error`. Сторож по ней
 * печатает RATE_LIMIT/FAILED. Без переменной ничего не делает.
 */
import { appendFileSync } from "node:fs";

// Пакет Pi — не зависимость репозитория: нужные поля событий описаны здесь.
interface PiLike {
  on(name: string, handler: (event: unknown) => void): unknown;
}

const LIMIT = /rate.?limit|\b429\b|quota|too many requests/i;

export default function piAlert(
  pi: PiLike,
  file = process.env.HARNESS_ALERT_FILE,
): void {
  if (file === undefined || file === "") return;
  let lastError = "";
  pi.on("message_end", (event) => {
    const { message } = event as {
      message?: { role?: string; stopReason?: string; errorMessage?: string };
    };
    if (message?.role === "assistant" && message.stopReason === "error") {
      // целиком: тип и маска считаются по полному тексту
      lastError = message.errorMessage ?? "error";
    }
  });
  pi.on("agent_before_settle", (event) => {
    if ((event as { outcome?: string }).outcome !== "error") return;
    const type = LIMIT.test(lastError) ? "rate_limit" : "error";
    try {
      appendFileSync(
        file,
        `${JSON.stringify({ type, source: "pi", message: lastError || "error" })}\n`,
      );
    } catch {
      // расширение не должно ронять Pi
    }
  });
}
