import { useEffect, useRef, useState, type ChangeEvent } from "react";

export type FileImportStatus = { kind: "reading" } | { kind: "failed"; detail: string } | null;

/** Only the latest selection from the mounted picker may reach its importer. */
export function useFileImport<T>({ read, onImport, onStart }: {
  read: (file: File) => Promise<T>;
  onImport: (payload: T) => void | Promise<void>;
  onStart?: () => void;
}) {
  const [status, setStatus] = useState<FileImportStatus>(null);
  const generationRef = useRef(0);
  useEffect(() => () => { generationRef.current += 1; }, []);

  const onChange = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Release the chooser immediately, including after a rejected read, so the
    // player can select the same file again without retaining the DOM event.
    input.value = "";
    if (!file) return;
    const generation = ++generationRef.current;
    setStatus({ kind: "reading" });
    try {
      onStart?.();
      const payload = await read(file);
      if (generation !== generationRef.current) return;
      await onImport(payload);
      if (generation === generationRef.current) setStatus(null);
    } catch (error) {
      if (generation === generationRef.current) {
        setStatus({ kind: "failed", detail: error instanceof Error ? error.message : "" });
      }
    }
  };
  return { status, onChange };
}
