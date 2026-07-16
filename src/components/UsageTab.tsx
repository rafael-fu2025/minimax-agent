import { useCallback, useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { RefreshCwIcon } from "lucide-react";
import { fetchUsage } from "../api";
import type { UsageResponse } from "../types/usage";

/** Human-readable "in Nh Mm" until reset. */
function relativeReset(resetAtIso: string): string {
  const ms = new Date(resetAtIso).getTime() - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "any moment";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin === 0 ? `in ${hours}h` : `in ${hours}h ${remMin}m`;
}

function QuotaBar(props: {
  title: string;
  summary: { totalQuota: number; totalUsed: number; remainingPercent: number; resetAt: string } | null;
}) {
  if (!props.summary) {
    return (
      <Card padding={3}>
        <Text type="body" weight="semibold">{props.title}</Text>
        <Text type="supporting" color="secondary">
          No quota data returned.
        </Text>
      </Card>
    );
  }
  const { totalQuota, totalUsed, remainingPercent, resetAt } = props.summary;
  const usedPercent = Math.max(0, Math.min(100, 100 - remainingPercent));
  const variant =
    usedPercent >= 95 ? "error" : usedPercent >= 80 ? "warning" : "success";
  return (
    <Card padding={3}>
      <div className="usage-tab__row">
        <Text type="body" weight="semibold">{props.title}</Text>
        <Badge label={`${usedPercent}% used`} variant={variant} />
      </div>
      <ProgressBar
        label={`${props.title} usage`}
        isLabelHidden
        value={usedPercent}
        max={100}
        variant={variant}
        formatValueLabel={(v) => `${v.toFixed(0)}%`}
      />
      <div className="usage-tab__counts">
        <Text type="supporting" color="secondary">
          {totalUsed.toLocaleString()} / {totalQuota.toLocaleString()} tokens used
        </Text>
        <Text type="supporting" color="secondary">
          {relativeReset(resetAt)} ({new Date(resetAt).toLocaleString()})
        </Text>
      </div>
    </Card>
  );
}

export function UsageTab() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const u = await fetchUsage();
    setLoading(false);
    if (!u.ok) {
      setError(u.error ?? "MiniMax returned an error");
      return;
    }
    setData(u.data);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <VStack gap={3} className="usage-tab">
      <div className="usage-tab__summary">
        <Text type="body" weight="semibold">
          Token Plan usage
        </Text>
        <div style={{ flex: 1 }} />
        {data?.fetchedAt && (
          <Text type="supporting" color="secondary">
            fetched {new Date(data.fetchedAt).toLocaleTimeString()}
          </Text>
        )}
        <Button
          label="Refresh"
          size="sm"
          variant="secondary"
          onClick={() => void reload()}
          isLoading={loading}
          icon={<Icon icon={RefreshCwIcon} size="sm" />}
        />
      </div>

      {error && (
        <Text type="supporting" color="secondary">
          {error}
        </Text>
      )}

      {!data && loading && <Spinner size="sm" label="Loading usage" />}

      {data?.ok && (
        <>
          <QuotaBar title="5-hour rolling" summary={data.fiveHour} />
          <QuotaBar title="Weekly" summary={data.weekly} />
        </>
      )}

      {data?.ok && data.modelRemains.length > 0 && (
        <details>
          <summary style={{ cursor: "pointer", color: "var(--color-text-secondary, #6b7280)" }}>
            Per-model breakdown ({data.modelRemains.length})
          </summary>
          <div className="usage-tab__table">
            {data.modelRemains.map((m) => (
              <div key={m.modelName} className="usage-tab__table-row">
                <Text type="body" weight="semibold">{m.modelName}</Text>
                <Text type="supporting" color="secondary">
                  5h: {100 - m.intervalRemainingPercent}% · weekly: {100 - m.weeklyRemainingPercent}%
                </Text>
              </div>
            ))}
          </div>
        </details>
      )}
    </VStack>
  );
}
