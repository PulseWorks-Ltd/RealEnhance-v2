export type QuotaMessageOptions = {
  isAdmin?: boolean;
  hasRoleInfo?: boolean;
};

const ADMIN_MESSAGE =
  "Your agency has used all of its image allowance for this month. Consider upgrading your monthly plan or purchasing an image add-on bundle. You can do this in the Billing section.";

const NON_ADMIN_MESSAGE =
  "Your agency has used all of its image allowance for this month. Please speak to your account administrator to upgrade the plan or purchase an image add-on bundle.";

const UNIFIED_MESSAGE =
  "Your agency has used all of its image allowance for this month and should consider upgrading the monthly plan or purchasing an image add-on bundle. If you are the administrator for this account, you can do this in the Billing section; otherwise please speak to your account administrator.";

export function getQuotaExceededMessage({ isAdmin, hasRoleInfo }: QuotaMessageOptions = {}): string {
  if (isAdmin) return ADMIN_MESSAGE;
  if (hasRoleInfo) return NON_ADMIN_MESSAGE;
  return UNIFIED_MESSAGE;
}
