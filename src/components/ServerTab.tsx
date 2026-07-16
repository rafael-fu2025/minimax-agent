// filepath: src/components/ServerTab.tsx
import { useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import {
  BoxIcon,
  CpuIcon,
  DatabaseIcon,
  HardDriveIcon,
  KeyRoundIcon,
  LayersIcon,
  PlugIcon,
  ZapIcon,
} from "lucide-react";
import { MinimaxLogo } from "./MinimaxLogo";
import { fetchHealth, fetchModels, type ModelsResponse } from "../api";
import type { ToolsResponse } from "../api";

interface ServerTabProps {
  data: ToolsResponse | null;
}

interface SectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

/** Section header: small uppercase title, optional description, then content. */
function Section({ title, description, children }: SectionProps) {
  return (
    <section className="server-tab__section">
      <header className="server-tab__section-header">
        <Text type="label" as="h3" weight="semibold">
          {title}
        </Text>
        {description && (
          <Text type="supporting" color="secondary">
            {description}
          </Text>
        )}
      </header>
      <div className="server-tab__section-body">{children}</div>
    </section>
  );
}

interface KeyValueProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  /** Optional secondary line shown muted under the value. */
  hint?: React.ReactNode;
}

/** Two-column key/value row with an icon. Used inside a section body. */
function KeyValue({ icon, label, value, hint }: KeyValueProps) {
  return (
    <div className="server-tab__kv">
      <div className="server-tab__kv-icon" aria-hidden>
        {icon}
      </div>
      <div className="server-tab__kv-text">
        <Text type="label" color="secondary" className="server-tab__kv-label">
          {label}
        </Text>
        <div className="server-tab__kv-value">{value}</div>
        {hint && (
          <Text
            type="supporting"
            color="secondary"
            className="server-tab__kv-hint"
          >
            {hint}
          </Text>
        )}
      </div>
    </div>
  );
}

function StatTile({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: React.ReactNode;
  tone?: "neutral" | "success" | "warning" | "info";
}) {
  return (
    <div className={`server-tab__stat server-tab__stat--${tone}`}>
      <Text
        type="supporting"
        color="secondary"
        className="server-tab__stat-label"
      >
        {label}
      </Text>
      <div className="server-tab__stat-value">{value}</div>
    </div>
  );
}

export function ServerTab({ data }: ServerTabProps) {
  const [health, setHealth] = useState<{
    ok: boolean;
    model: string;
    hasKey: boolean;
  } | null>(null);
  const [models, setModels] = useState<ModelsResponse | null>(null);

  // Pull health + models in parallel so the server tab reflects the
  // currently-selected model and the key pool state.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [h, m] = await Promise.all([fetchHealth(), fetchModels()]);
      if (cancelled) return;
      if (h.ok) setHealth(h.data);
      if (m.ok) setModels(m.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  const memory = data?.memory;
  const sandboxRoot = data?.sandboxRoot ?? null;
  const mcpServers = data?.mcpServers ?? [];
  const totals = data?.totals;

  const activeModel = health?.model ?? "—";
  const activeModelLimit = models?.limits.find((l) => l.id === activeModel);
  const hasApiKey = health?.hasKey ?? false;
  const memoryEnabled = memory?.provider === "minimax";
  const sandboxConfigured = Boolean(sandboxRoot);

  return (
    <VStack gap={4} className="server-tab">
      {/* ----- Hero / status card ---------------------------------------- */}
      <div className="server-tab__hero">
        <div className="server-tab__hero-main">
          <div className="server-tab__hero-row">
            <MinimaxLogo
              className="server-tab__hero-logo"
              width="1em"
              height="1em"
              decorative
            />
            <Text type="display-3" as="h2">
              Server
            </Text>
            <Badge
              label={hasApiKey ? "Ready" : "Needs attention"}
              variant={hasApiKey ? "success" : "warning"}
            />
          </div>
          <Text type="body" color="secondary">
            Live configuration returned by <code>GET /api/tools</code>. Refresh
            the dialog (top right) to re-pull.
          </Text>
        </div>

        <div className="server-tab__hero-stats">
          <StatTile
            label="Active model"
            value={<span className="server-tab__mono">{activeModel}</span>}
            tone={hasApiKey ? "info" : "warning"}
          />
          <StatTile
            label="Tools registered"
            value={totals ? totals.tools : "—"}
            tone="neutral"
          />
          <StatTile
            label="Memory"
            value={memoryEnabled ? "Connected" : "Stub"}
            tone={memoryEnabled ? "success" : "neutral"}
          />
          <StatTile
            label="MCP servers"
            value={mcpServers.length}
            tone={mcpServers.length > 0 ? "info" : "neutral"}
          />
        </div>
      </div>

      {/* ----- Model & inference ----------------------------------------- */}
      <Section
        title="Model & inference"
        description="The chat model active for new turns and its documented context window."
      >
        <KeyValue
          icon={<Icon icon={CpuIcon} size="sm" />}
          label="Active model"
          value={
            <span className="server-tab__mono server-tab__mono--lg">
              {activeModel}
            </span>
          }
          hint={
            activeModelLimit && activeModelLimit.context
              ? `Context ${activeModelLimit.context.toLocaleString()} tokens · Max output ${activeModelLimit.maxOutput?.toLocaleString() ?? "—"}`
              : "Limits not declared for this model."
          }
        />
        <KeyValue
          icon={<Icon icon={KeyRoundIcon} size="sm" />}
          label="API key"
          value={
            hasApiKey ? (
              <Badge label="Configured" variant="success" />
            ) : (
              <Badge label="Missing" variant="warning" />
            )
          }
          hint={
            hasApiKey
              ? "Bootstrap env-var or one of the Keys-tab secrets is set."
              : "Add MINIMAX_API_KEY to .env or add a key in Settings → Keys."
          }
        />
        <KeyValue
          icon={<Icon icon={ZapIcon} size="sm" />}
          label="Available models"
          value={
            models?.models.length ? (
              <div className="server-tab__chips">
                {models.models.slice(0, 12).map((id) => (
                  <Badge
                    key={id}
                    label={id}
                    variant={id === activeModel ? "info" : "neutral"}
                  />
                ))}
                {models.models.length > 12 && (
                  <Text type="supporting" color="secondary">
                    +{models.models.length - 12} more
                  </Text>
                )}
              </div>
            ) : (
              <Text type="supporting" color="secondary">
                —
              </Text>
            )
          }
        />
      </Section>

      {/* ----- Sandbox ---------------------------------------------------- */}
      <Section
        title="Sandbox"
        description="All file and exec tools run against this root. Paths must be relative."
      >
        <KeyValue
          icon={<Icon icon={HardDriveIcon} size="sm" />}
          label="Sandbox root"
          value={
            sandboxConfigured ? (
              <CodeBlock
                code={sandboxRoot!}
                size="sm"
                container="section"
                hasCopyButton
                hasLanguageLabel={false}
                width="100%"
              />
            ) : (
              <Text type="body" color="secondary">
                Not set — file tools fall back to <code>./workspace</code>.
              </Text>
            )
          }
          hint="Configure via TOOL_SANDBOX_ROOT in .env, or change it from the workspace explorer."
        />
      </Section>

      {/* ----- Memory ----------------------------------------------------- */}
      <Section
        title="Memory"
        description="pgvector-backed recall of prior user/assistant turns across all conversations."
      >
        <KeyValue
          icon={<Icon icon={LayersIcon} size="sm" />}
          label="Provider"
          value={
            memory ? (
              <div className="server-tab__inline">
                <Badge
                  label={memory.provider}
                  variant={memoryEnabled ? "info" : "neutral"}
                />
                <Text type="body" color="secondary">
                  · model <strong>{memory.model}</strong> · dim{" "}
                  <strong>{memory.dim}</strong>
                </Text>
              </div>
            ) : (
              <Text type="supporting" color="secondary">
                —
              </Text>
            )
          }
          hint={
            memoryEnabled
              ? "Top-5 similar memories are prepended to the system prompt on every turn."
              : "No MINIMAX_API_KEY set — recall uses a deterministic stub."
          }
        />
        <KeyValue
          icon={<Icon icon={DatabaseIcon} size="sm" />}
          label="Vector index"
          value={
            <div className="server-tab__inline">
              <Badge label="HNSW" variant="info" />
              <Text type="body" color="secondary">
                · cosine distance · sub-ms recall
              </Text>
            </div>
          }
          hint="Run npm run db:reindex after changing EMBEDDING_DIM."
        />
      </Section>

      {/* ----- MCP servers ------------------------------------------------ */}
      <Section
        title="MCP servers"
        description="Tools dynamically registered from external Model Context Protocol servers."
      >
        {mcpServers.length === 0 ? (
          <div className="server-tab__empty">
            <Icon icon={PlugIcon} size="sm" />
            <Text type="body" color="secondary">
              No servers connected. Set <code>MCP_SERVERS</code> in{" "}
              <code>.env</code> to attach one.
            </Text>
          </div>
        ) : (
          <div className="server-tab__mcp-grid">
            {mcpServers.map((s) => {
              const count = (data?.tools ?? []).filter(
                (t) => t.source === `mcp:${s}`,
              ).length;
              return (
                <div key={s} className="server-tab__mcp-card">
                  <div className="server-tab__mcp-icon" aria-hidden>
                    <Icon icon={BoxIcon} size="sm" />
                  </div>
                  <div className="server-tab__mcp-text">
                    <Text
                      type="body"
                      weight="semibold"
                      className="server-tab__mono"
                    >
                      {s}
                    </Text>
                    <Text type="supporting" color="secondary">
                      {count} tool{count === 1 ? "" : "s"} exposed
                    </Text>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* ----- Persistence ------------------------------------------------ */}
      <Section
        title="Persistence"
        description="Server-side conversation and message storage. Stateless by default."
      >
        <KeyValue
          icon={<Icon icon={DatabaseIcon} size="sm" />}
          label="Storage backend"
          value={
            <div className="server-tab__inline">
              <Badge label="Postgres + Drizzle" variant="info" />
              <Text type="body" color="secondary">
                · gated by <code>DATABASE_URL</code>
              </Text>
            </div>
          }
          hint="Without DATABASE_URL, the server runs stateless and conversation endpoints return 503."
        />
      </Section>
    </VStack>
  );
}
