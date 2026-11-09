declare function useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void];
declare function useReducer<S, A>(reducer: (state: S, action: A) => S, initial: S): [S, (action: A) => void];
declare function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
declare function useRef<T>(initial: T): { current: T };
declare function loadSettings(): { size: number };

function reducer(count: number, action: { type: 'add' | 'clear' }): number {
  return action.type === 'add' ? count + 1 : 0;
}

export function Badge({ label, size }: { label: string; size: number }) {
  return <b style={{ fontSize: size }}>{label}</b>;
}

export function Panel({ title }: { title: string }) {
  return (
    <section>
      <Badge label={title} size={12} />
    </section>
  );
}

export function Settings({ name }: { name: string }) {
  const [settings] = useState(loadSettings());
  const [label, setLabel] = useState('');
  const [count, dispatch] = useReducer(reducer, 0);
  const [mode, setMode] = useState('view');
  const renders = useRef(0);
  const options = { name };
  function format(value: string) {
    return value.toUpperCase();
  }

  useEffect(() => {
    setLabel(format(name));
  }, [name, format, mode]);

  useEffect(() => {
    console.log(options);
  }, [{ name }]);

  if (count > 10) setMode('edit');

  return (
    <div>
      <button onClick={() => dispatch({ type: 'add' })}>+</button>
      <button onClick={() => dispatch({ type: 'clear' })}>reset</button>
      <Panel title={label} />
      <span>{settings.size} {renders.current}</span>
    </div>
  );
}
