import React from "react";
import { Box, Text, useInput } from "ink";

export interface InputProps {
  value: string;
  cursor: number;
  onChange(value: string, cursor: number): void;
  onSubmit(value: string): void;
  /** Called for keys the editor does not consume; return true if handled. */
  onKey?(input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]): boolean | void;
  active: boolean;
  placeholder?: string;
}

/** Single-line editor with emacs-style shortcuts (Ctrl+A/E/K/U/W), mirroring qca's CustomInput. */
export function Input({ value, cursor, onChange, onSubmit, onKey, active, placeholder }: InputProps) {
  useInput(
    (input, key) => {
      if (onKey?.(input, key)) return;
      if (key.return) return onSubmit(value);
      if (key.leftArrow) return onChange(value, Math.max(0, cursor - 1));
      if (key.rightArrow) return onChange(value, Math.min(value.length, cursor + 1));
      if (key.backspace || key.delete) {
        if (cursor === 0) return;
        return onChange(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      }
      if (key.ctrl) {
        switch (input) {
          case "a": return onChange(value, 0);
          case "e": return onChange(value, value.length);
          case "k": return onChange(value.slice(0, cursor), cursor);
          case "u": return onChange(value.slice(cursor), 0);
          case "w": {
            const head = value.slice(0, cursor).replace(/\S+\s*$/, "");
            return onChange(head + value.slice(cursor), head.length);
          }
          default: return;
        }
      }
      if (key.meta || key.escape || key.tab || key.upArrow || key.downArrow) return;
      if (!input) return;
      // A pasted / fast-typed chunk can carry the newline inside it: treat the first newline as Enter.
      const nl = input.search(/[\r\n]/);
      if (nl >= 0) {
        const head = input.slice(0, nl);
        onSubmit(value.slice(0, cursor) + head + value.slice(cursor));
        return;
      }
      onChange(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
    },
    { isActive: active },
  );
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);
  return (
    <Box borderStyle="round" borderColor={active ? "cyan" : "gray"} paddingX={1}>
      <Text color="cyan">› </Text>
      {value.length === 0 && placeholder ? (
        <>
          <Text inverse> </Text>
          <Text dimColor>{placeholder}</Text>
        </>
      ) : (
        <Text>
          {before}
          <Text inverse>{at}</Text>
          {after}
        </Text>
      )}
    </Box>
  );
}
