import { Field } from "./ui";
import type { ProjectBrief } from "./types";
import "./brief.css";
export const briefLabels: Record<keyof ProjectBrief, string> = {
  goal: "Goal",
  audience: "Intended user",
  requirements: "Requirements",
  constraints: "Constraints",
  outOfScope: "Out of scope",
  decisions: "Agreed decisions",
  assumptions: "Assumptions",
};
export default function BriefFields({
  value,
  onChange,
  onCommit,
  readOnly = false,
}: {
  value: ProjectBrief;
  onChange?: (field: keyof ProjectBrief, value: string) => void;
  onCommit?: () => void;
  readOnly?: boolean;
}) {
  return (
    <div className="brief-fields">
      {(Object.keys(briefLabels) as (keyof ProjectBrief)[]).map((field) =>
        readOnly ? (
          <section className="brief-field-read" key={field}>
            <h3>{briefLabels[field]}</h3>
            <p>{value[field] || "Not specified"}</p>
          </section>
        ) : (
          <Field label={briefLabels[field]} key={field}>
            <textarea
              value={value[field]}
              rows={field === "goal" || field === "audience" ? 2 : 3}
              maxLength={32768}
              onChange={(event) => onChange?.(field, event.target.value)}
              onBlur={onCommit}
            />
          </Field>
        ),
      )}
    </div>
  );
}
