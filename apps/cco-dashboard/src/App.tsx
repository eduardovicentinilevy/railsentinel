import { AlarmsPanel } from './components/AlarmsPanel';
import { EdgeNodesPanel } from './components/EdgeNodesPanel';
import { EventLog } from './components/EventLog';
import { Footer } from './components/Footer';
import { KpiRow } from './components/KpiRow';
import { RestrictionsPanel } from './components/RestrictionsPanel';
import { SafetyAuditCard } from './components/SafetyAuditCard';
import { Schematic } from './components/Schematic';
import { Sparkline } from './components/Sparkline';
import { TopBar } from './components/TopBar';
import { TspPanel } from './components/TspPanel';
import { CcoProvider } from './state/CcoProvider';

export function App() {
  return (
    <CcoProvider>
      <div className="shell">
        <TopBar />
        <KpiRow />
        <main className="grid">
          <div className="col">
            <Schematic />
            <Sparkline />
            <TspPanel />
            <EdgeNodesPanel />
          </div>
          <div className="col">
            <AlarmsPanel />
            <RestrictionsPanel />
            <EventLog />
            <SafetyAuditCard />
          </div>
        </main>
        <Footer />
      </div>
    </CcoProvider>
  );
}
