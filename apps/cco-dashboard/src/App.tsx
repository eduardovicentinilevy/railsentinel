import { Shell } from './components/shell/Shell';
import { CcoProvider } from './state/CcoProvider';
import { UiProvider } from './ui/UiProvider';

export function App() {
  return (
    <CcoProvider>
      <UiProvider>
        <Shell />
      </UiProvider>
    </CcoProvider>
  );
}
