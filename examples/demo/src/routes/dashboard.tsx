import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { StatTile } from "~/components/ui/stat-tile";

// Every line marked VIOLATION is something an AI assistant plausibly writes.
export function Dashboard() {
  return (
    <main>
      <h1 className="text-2xl font-semibold">Dashboard</h1>                {/* VIOLATION 4: fights the type scale */}
      <Card className="bg-muted rounded-xl">                               {/* VIOLATION 3: appearance override, token or not */}
        <StatTile label="Revenue" value="$12k" />                          {/* VIOLATION 2: component has no @approved marker */}
        <button onClick={() => save()}>Save</button>                       {/* VIOLATION 1: raw <button> */}
        <Button variant="secondary" className="mt-4">Cancel</Button>       {/* fine: layout class on an approved component */}
      </Card>
      <p style={{ color: "#1f2937" }}>Footer</p>                           {/* VIOLATION: hardcoded color */}
    </main>
  );
}
