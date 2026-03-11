import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../lib/api";

interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string) => void;
}

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const modelsQ = useQuery({
    queryKey: ["models"],
    queryFn: () =>
      apiFetch<Array<{ id: string; name: string }>>(
        "/api/models",
        undefined,
        false,
      ),
  });

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-[var(--divider)] bg-[var(--bg-surface)] px-3 py-2 text-sm"
    >
      {modelsQ.data?.map((model) => (
        <option key={model.id} value={model.id}>
          {model.name}
        </option>
      ))}
    </select>
  );
}
