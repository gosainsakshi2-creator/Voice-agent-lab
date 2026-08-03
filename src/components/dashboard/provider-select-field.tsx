import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProviderDescriptor } from "@/types/provider.types";

interface ProviderSelectFieldProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly ProviderDescriptor[];
  readonly onChange: (id: string) => void;
  readonly disabled?: boolean;
}

export function ProviderSelectField({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: ProviderSelectFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger>
          <SelectValue placeholder="Select a provider" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.displayName}
              <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                {option.version}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
