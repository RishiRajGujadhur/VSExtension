declare function useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void];
declare function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
declare function useMemo<T>(compute: () => T, deps: unknown[]): T;
declare function useCallback<T>(callback: T, deps: unknown[]): T;
declare function useRef<T>(initial: T): { current: T };
declare function useContext<T>(context: { value: T }): T;
declare const ThemeContext: { value: string };

function useCart(id: string): { items: string[]; refresh: () => void } {
  const [items, setItems] = useState<string[]>([]);
  const refresh = () => setItems([id]);
  return { items, refresh };
}

export function CartPage({ userId, discount }: { userId: string; discount: number }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const theme = useContext(ThemeContext);
  const timer = useRef(0);
  const { items, refresh } = useCart(userId);
  const visible = useMemo(() => items.filter((i) => i.includes(query)), [items, query]);
  const next = useCallback(() => setPage((p) => p + 1), []);

  useEffect(() => {
    refresh();
    setPage(1);
  }, [userId]);

  useEffect(() => {
    timer.current = query.length;
    return () => {
      timer.current = 0;
    };
  }, []);

  function handleSearch(text: string) {
    setQuery(text);
  }

  return (
    <div className={theme}>
      <input value={query} onChange={(e) => handleSearch(e.target.value)} />
      <span>{visible.length * page - discount}</span>
      <button onClick={next}>Next</button>
    </div>
  );
}
