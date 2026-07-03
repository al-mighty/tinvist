import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { describeProposal } from "../strategy/types.js";
import type { Approver, ApprovalRequest } from "./types.js";

/**
 * Подтверждение через терминал. MVP-канал: показывает предложение, вердикт
 * guard-лимитов и режим отправки, спрашивает y/n.
 */
export class CliApprover implements Approver {
  async requestApproval(req: ApprovalRequest): Promise<boolean> {
    const { proposal, guard } = req;

    console.log("\n" + "─".repeat(60));
    console.log("ПРЕДЛОЖЕНИЕ СДЕЛКИ");
    console.log("─".repeat(60));
    console.log(describeProposal(proposal));
    console.log(`Обоснование: ${proposal.rationale}`);
    console.log(`Контур: ${req.backendKind}`);

    if (guard.warnings.length) {
      console.log("\n⚠ Предупреждения:");
      for (const w of guard.warnings) console.log(`  • ${w}`);
    }
    if (!guard.ok) {
      console.log("\n✖ Guard-лимиты НАРУШЕНЫ:");
      for (const v of guard.violations) console.log(`  • ${v}`);
      console.log("\nСделка заблокирована лимитами и не может быть исполнена.");
      return false;
    }

    // Ярко выделяем реальную отправку денег.
    if (req.willSend && req.backendKind === "prod") {
      console.log(`\n🔴 РЕЖИМ ОТПРАВКИ: ${req.sendMode}`);
    } else {
      console.log(`\nРежим отправки: ${req.willSend ? req.sendMode : "DRY-RUN (не отправляется)"}`);
    }

    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await rl.question("\nПодтвердить сделку? [y/N] ")).trim().toLowerCase();
      return answer === "y" || answer === "yes" || answer === "да";
    } finally {
      rl.close();
    }
  }
}
