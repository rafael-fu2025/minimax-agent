import { useCallback, useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import {
  CheckCircle2Icon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  addKey,
  deleteKey,
  fetchKeyUsage,
  testKey,
  updateKey,
} from "../api-keys";
import type { KeyInfo, KeyUsageSummary } from "../types/keys";

function statusBadge(k: KeyInfo): { label: string; variant: "success" | "neutral" } {
  if (k.lastErrorAt && Date.parse(k.lastErrorAt) > Date.now() - 5 * 60_000) {
    return { label: "Errored", variant: "neutral" };
  }
  return k.status === "active"
    ? { label: "Active", variant: "success" }
    : { label: "Disabled", variant: "neutral" };
}

function AddKeyDialog(props: {
  isOpen: boolean;
  onClose: () => void;
  onAdded: (k: KeyInfo) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [secret, setSecret] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (props.isOpen) {
      setName("");
      setSecret("");
      setHint("");
      setError(null);
      setBusy(false);
    }
  }, [props.isOpen]);

  const submit = useCallback(async () => {
    if (!name.trim()) {
      setError("name is required");
      return;
    }
    if (!secret.trim()) {
      setError("secret is required");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await addKey({
      name: name.trim(),
      secret: secret.trim(),
      hint: hint.trim() || undefined,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    props.onAdded(r.key);
    props.onClose();
  }, [name, secret, hint, props]);

  return (
    <Dialog
      isOpen={props.isOpen}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      purpose="form"
      width={520}
    >
      <VStack gap={3} style={{ padding: "12px 4px" }}>
        <Heading level={2}>Add MiniMax API key</Heading>
        <TextInput
          label="Name"
          value={name}
          onChange={(v) => setName(v)}
          placeholder="e.g. work, side-project"
        />
        <TextInput
          label="API key"
          type="password"
          value={secret}
          onChange={(v) => setSecret(v)}
          placeholder="sk-…"
        />
        <TextInput
          label="Hint (optional)"
          value={hint}
          onChange={(v) => setHint(v)}
          placeholder="main account, spare key, etc."
        />
        {error && (
          <Text type="supporting" color="secondary">
            {error}
          </Text>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Button label="Cancel" variant="secondary" onClick={props.onClose} />
          <Button
            label="Add"
            variant="primary"
            isLoading={busy}
            isDisabled={busy}
            onClick={submit}
          />
        </div>
      </VStack>
    </Dialog>
  );
}

function KeyRow(props: {
  k: KeyInfo;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [toggling, setToggling] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  const toggle = useCallback(async () => {
    setToggling(true);
    setTestResult(null);
    const next = props.k.status === "active" ? "disabled" : "active";
    const r = await updateKey(props.k.id, { status: next });
    setToggling(false);
    if (!r.ok) {
      props.onError(r.error ?? "unknown error");
      return;
    }
    props.onChanged();
  }, [props]);

  const remove = useCallback(async () => {
    if (props.k.isBootstrap) return;
    if (!window.confirm(`Delete key "${props.k.name}"? This cannot be undone.`)) return;
    setToggling(true);
    const r = await deleteKey(props.k.id);
    setToggling(false);
    if (!r.ok) {
      props.onError(r.error ?? "unknown error");
      return;
    }
    props.onChanged();
  }, [props]);

  const test = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    const r = await testKey(props.k.id);
    setTesting(false);
    setTestResult(
      r.ok
        ? { ok: true, msg: `${r.modelCount ?? 0} models` }
        : { ok: false, msg: r.error ?? "failed" },
    );
  }, [props]);

  const badge = statusBadge(props.k);

  return (
    <div className="keys-row">
      <div className="keys-row__name">
        <Text type="body" weight="semibold">
          {props.k.name}
        </Text>
        {props.k.isBootstrap && <Badge label="env" variant="info" />}
        <Text type="supporting" color="secondary">
          {props.k.prefix}
        </Text>
        {props.k.hint && (
          <Text type="supporting" color="secondary">
            — {props.k.hint}
          </Text>
        )}
      </div>
      <div className="keys-row__status">
        <Badge label={badge.label} variant={badge.variant} />
      </div>
      <div className="keys-row__usage">
        <Text type="supporting" color="secondary">
          {props.k.requestsTotal} calls · in {props.k.tokensInTotal} · out{" "}
          {props.k.tokensOutTotal}
        </Text>
        {props.k.lastErrorMsg && (
          <span title={props.k.lastErrorMsg}>
            <Text type="supporting" color="secondary">
              last: {props.k.lastErrorMsg.slice(0, 60)}
              {props.k.lastErrorMsg.length > 60 ? "…" : ""}
            </Text>
          </span>
        )}
      </div>
      <div className="keys-row__test">
        {testing ? (
          <Spinner size="sm" />
        ) : testResult ? (
          <Text type="supporting" color="secondary">
            {testResult.ok ? "✓ " : "✗ "}
            {testResult.msg}
          </Text>
        ) : null}
      </div>
      <div className="keys-row__actions">
        <IconButton
          label="Test this key"
          size="sm"
          variant="ghost"
          isDisabled={toggling || testing}
          onClick={test}
          icon={<Icon icon={RefreshCwIcon} size="sm" />}
        />
        <IconButton
          label={props.k.status === "active" ? "Disable" : "Enable"}
          size="sm"
          variant="ghost"
          isDisabled={toggling || testing}
          onClick={toggle}
          icon={
            <Icon
              icon={props.k.status === "active" ? XIcon : CheckCircle2Icon}
              size="sm"
            />
          }
        />
        {!props.k.isBootstrap && (
          <IconButton
            label="Delete"
            size="sm"
            variant="ghost"
            isDisabled={toggling || testing}
            onClick={remove}
            icon={<Icon icon={Trash2Icon} size="sm" />}
          />
        )}
      </div>
    </div>
  );
}

export function KeysTab() {
  const [data, setData] = useState<KeyUsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const u = await fetchKeyUsage();
    setLoading(false);
    if (!u.ok) {
      setError(u.error || "Couldn't reach the server.");
      return;
    }
    setData(u.data);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <VStack gap={3} className="keys-tab">
      <div className="keys-tab__summary">
        <Text type="body" weight="semibold">
          Pool: {data?.poolSize ?? "…"} keys ({data?.activeCount ?? "…"} active)
        </Text>
        <Text type="supporting" color="secondary">
          Total: {data?.totals.requestsTotal ?? 0} calls · in{" "}
          {data?.totals.tokensInTotal ?? 0} · out{" "}
          {data?.totals.tokensOutTotal ?? 0} tokens
        </Text>
        <div style={{ flex: 1 }} />
        <Button
          label="Refresh"
          size="sm"
          variant="secondary"
          onClick={() => void reload()}
          isLoading={loading}
          icon={<Icon icon={RefreshCwIcon} size="sm" />}
        />
        <Button
          label="Add key"
          size="sm"
          variant="primary"
          onClick={() => setAddOpen(true)}
          icon={<Icon icon={PlusIcon} size="sm" />}
        />
      </div>

      {error && (
        <Text type="supporting" color="secondary">
          {error}
        </Text>
      )}

      {!data && loading && <Spinner size="sm" label="Loading keys" />}

      <div className="keys-tab__rows">
        {data?.keys.map((k) => (
          <KeyRow
            key={k.id}
            k={k}
            onChanged={() => void reload()}
            onError={(msg) => setError(msg)}
          />
        ))}
      </div>

      <AddKeyDialog
        isOpen={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => void reload()}
        onError={(msg) => setError(msg)}
      />
    </VStack>
  );
}

