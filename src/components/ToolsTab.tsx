import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { CpuIcon } from "lucide-react";
import { useState } from "react";
import type { ToolsResponse } from "../api";

interface ToolsTabProps {
  data: ToolsResponse | null;
  loading: boolean;
  onRefresh: () => Promise<void> | void;
}

/** Map a tool source string to a Badge variant. */
function sourceVariant(source: string): "neutral" | "info" | "purple" {
  if (source === "native") return "neutral";
  if (source.startsWith("mcp")) return "info";
  return "purple";
}

export function ToolsTab({ data, loading, onRefresh }: ToolsTabProps) {
  if (loading && !data) {
    return null; // parent shows the loading spinner.
  }
  const tools = data?.tools ?? [];
  const totals = data?.totals;

  // Single-open accordion state. `null` means nothing is expanded; clicking
  // an already-open row collapses it.
  const [openTool, setOpenTool] = useState<string | null>(null);

  if (tools.length === 0) {
    return (
      <EmptyState
        icon={<Icon icon={CpuIcon} size="lg" />}
        title="No tools registered"
        description="The server returned an empty tool registry."
        actions={
          <Button label="Refresh" variant="secondary" onClick={() => void onRefresh()} />
        }
      />
    );
  }

  return (
    <VStack gap={2} className="tools-tab">
      <div className="tools-tab__header">
        <Text type="supporting">
          {totals ? (
            <>
              <strong>{totals.tools}</strong> tools registered
              {" · "}
              {totals.native} native
              {" · "}
              {totals.mcp} mcp
            </>
          ) : (
            "Tools registered with the agent"
          )}
        </Text>
        {loading && <Spinner size="sm" label="Refreshing" />}
      </div>

      <div className="tools-tab__list" role="list">
        {tools.map((t) => {
          const isOpen = openTool === t.name;
          return (
            <Collapsible
              key={t.name}
              isOpen={isOpen}
              onOpenChange={(next) =>
                setOpenTool(next ? t.name : null)
              }
              className={`tools-tab__row${isOpen ? " is-open" : ""}`}
              trigger={
                <div className="tools-tab__row-trigger">
                  <div className="tools-tab__name-cell">
                    <CodeBlock
                      code={t.name}
                      size="sm"
                      container="section"
                      hasCopyButton={false}
                      hasLanguageLabel={false}
                    />
                  </div>
                  <div className="tools-tab__source-cell">
                    <Badge
                      label={t.source}
                      variant={sourceVariant(t.source)}
                    />
                  </div>
                </div>
              }
            >
              <div className="tools-tab__row-body" role="listitem">
                <div className="tools-tab__description">
                  {t.description}
                </div>
              </div>
            </Collapsible>
          );
        })}
      </div>
    </VStack>
  );
}
