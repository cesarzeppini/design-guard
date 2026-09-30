// @approved
export function Button({ variant = "primary", children }: { variant?: "primary" | "secondary"; children: React.ReactNode }) {
  return <button className={`btn btn-${variant}`}>{children}</button>;
}
