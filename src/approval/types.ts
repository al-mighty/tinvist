import type { GuardVerdict } from "../safety/guards.js";
import type { TradeProposal } from "../strategy/types.js";

export interface ApprovalRequest {
  proposal: TradeProposal;
  guard: GuardVerdict;
  backendKind: "sandbox" | "prod";
  /** Будет ли заявка реально отправлена (иначе — dry-run/лог). */
  willSend: boolean;
  /** Пояснение режима отправки (например «PROD РЕАЛЬНЫЕ ДЕНЬГИ»). */
  sendMode: string;
}

/** Канал подтверждения сделки человеком. */
export interface Approver {
  /** true — сделку подтвердили, false — отклонили. */
  requestApproval(req: ApprovalRequest): Promise<boolean>;
  close?(): Promise<void>;
}
