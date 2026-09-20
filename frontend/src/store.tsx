import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import {
  fromEnvelope,
  reducer,
  SaveQueue,
  type Action,
  type SaveAck,
  type Session,
} from "./history";
import { copy, type Content, type Envelope, type Viewport } from "./types";
export type Store = {
  session: Session;
  change: (
    edit: (c: Content) => void,
    label: string,
    diagramId?: string,
    group?: boolean,
  ) => void;
  commit: () => void;
  undo: () => void;
  redo: () => void;
  setView: (id: string, v: Viewport) => void;
  flush: () => Promise<boolean>;
  getSnapshot: () => Session;
  synchronize: (
    request: (snapshot: Session) => Promise<Envelope>,
  ) => Promise<Envelope>;
  saveStatus: string;
  saveError: string;
};
export const StoreContext = createContext<Store | null>(null);
export function ProjectProvider({
  envelope,
  children,
}: {
  envelope: Envelope;
  children: ReactNode;
}) {
  const [session, setSession] = useReducer(
    (_: Session, next: Session) => next,
    fromEnvelope(envelope),
  );
  const ref = useRef(session);
  const [saveStatus, setStatus] = useState("saved");
  const [saveError, setError] = useState("");
  const statusRef = useRef("saved");
  const send = (action: Action) => {
    const next = reducer(ref.current, action);
    ref.current = next;
    setSession(next);
  };
  const [queue] = useState(
    () =>
      new SaveQueue(
        () => ref.current,
        send,
        (id, body) =>
          api<SaveAck>(`/projects/${id}`, {
            method: "PUT",
            body: JSON.stringify(body),
          }),
        (status, message = "") => {
          statusRef.current = status;
          setStatus(status);
          setError(message);
        },
        envelope.history.map((h) => h.id),
        envelope.revision,
      ),
  );
  useEffect(() => {
    if (
      statusRef.current === "failed" ||
      statusRef.current === "conflict" ||
      session.generation === session.savedGeneration
    )
      return;
    const timer = setTimeout(() => {
      send({ type: "commit" });
      void queue.flush();
    }, 600);
    return () => clearTimeout(timer);
  }, [session.generation, session.savedGeneration, queue]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (ref.current.generation !== ref.current.savedGeneration) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);
  const value: Store = useMemo(
    () => ({
      session,
      change: (edit, label, diagramId, group = false) => {
        const c = copy(ref.current.content);
        edit(c);
        send({ type: "edit", content: c, label, diagramId, group });
      },
      commit: () => send({ type: "commit" }),
      undo: () => send({ type: "undo" }),
      redo: () => send({ type: "redo" }),
      setView: (diagramId, view) => send({ type: "view", diagramId, view }),
      flush: () => queue.flush(),
      getSnapshot: () => ref.current,
      synchronize: (request) => queue.synchronize(request),
      saveStatus,
      saveError,
    }),
    [session, saveStatus, saveError, queue],
  );
  return (
    <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
  );
}
export function useProject() {
  const value = useContext(StoreContext);
  if (!value) throw new Error("No project is open.");
  return value;
}
