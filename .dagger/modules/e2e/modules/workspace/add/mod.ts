import { tag } from "@ws/util";

export function describe(n: number): string {
  return `${tag()}:${n}`;
}
