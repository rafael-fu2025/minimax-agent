import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ShieldAlertIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { Icon } from "@astryxdesign/core/Icon";
import { useState } from "react";

export interface PendingApproval {
  id: string;
  tool: string;
  arguments: string;
  preview: string;
}

interface ApprovalDialogProps {
  /** `null` when no approval is pending — the dialog stays hidden. */
  approval: PendingApproval | null;
  /** Currently-active permission mode (shown for context). */
  mode: "safe" | "accept-edits" | "bypass";
  /** Resolve the approval; the server returns its decision + a tool result. */
  onResolve: (decision: "allow" | "deny") => void;
}

/**
 * Modal that blocks the chat until the user explicitly allows or denies a
 * mutating tool call. The dialog is `purpose="form"` so backdrop-click is
 * disabled and the user must press one of the two buttons or Esc (Esc = deny).
 */
export function ApprovalDialog({ approval, mode, onResolve }: ApprovalDialogProps) {
  const [submitting, setSubmitting] = useState<"allow" | "deny" | null>(null);

  if (!approval) return null;

  const handle = (decision: "allow" | "deny") => {
    if (submitting) return;
    setSubmitting(decision);
    try {
      onResolve(decision);
    } finally {
      // Always reset; the parent unmounts this dialog once `approval` becomes null.
      setSubmitting(null);
    }
  };

  return (
    <Dialog
      isOpen={!!approval}
      onOpenChange={(open) => {
        // Esc dismissal = deny (fail-closed). The agent loop auto-cleans up.
        if (!open) handle("deny");
      }}
      purpose="form"
      width={560}
      maxHeight="70vh"
    >
      <VStack gap={3} className="approval-dialog__body">
        <div className="approval-dialog__header">
          <Icon icon={ShieldAlertIcon} size="md" />
          <Text type="display-3" as="h2">
            Approve tool call?
          </Text>
        </div>

        <Text type="supporting" color="secondary">
          The agent wants to run <strong>{approval.tool}</strong> under{" "}
          <code>{mode}</code>. Review what it intends to do before allowing.
        </Text>

        <div className="approval-dialog__preview">
          <Text type="label" color="secondary">
            Preview
          </Text>
          <CodeBlock
            code={approval.preview}
            hasCopyButton
            hasLanguageLabel={false}
            container="section"
            width="100%"
            size="sm"
          />
        </div>

        <details className="approval-dialog__raw">
          <summary>Raw arguments</summary>
          <CodeBlock
            code={approval.arguments}
            language="json"
            hasCopyButton
            hasLanguageLabel
            container="section"
            width="100%"
            size="sm"
          />
        </details>

        <div className="approval-dialog__footer">
          <Button
            label="Deny"
            icon={<Icon icon={XIcon} size="sm" />}
            variant="secondary"
            onClick={() => handle("deny")}
            isDisabled={!!submitting}
          />
          <Button
            label="Allow this call"
            icon={<Icon icon={ShieldCheckIcon} size="sm" />}
            variant="primary"
            onClick={() => handle("allow")}
            isLoading={submitting === "allow"}
            isDisabled={!!submitting}
          />
        </div>
      </VStack>
    </Dialog>
  );
}
