import { FleetCard } from '../components/line/FleetCard';
import { LineCard } from '../components/line/LineDiagram';
import { TrainPanel } from '../components/line/TrainPanel';
import { Sparkline } from '../components/Sparkline';

export function LineView() {
  return (
    <div className="view">
      <LineCard />
      <div className="split wide-left">
        <div className="stack">
          <FleetCard />
          <Sparkline />
        </div>
        <TrainPanel />
      </div>
    </div>
  );
}
