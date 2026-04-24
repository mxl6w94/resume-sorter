/*
 * ============================================================================
 *  tests/e2e/fixtures/firebase-stubs.js — In-browser Firebase stub bundle
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The production app imports Firebase directly from Google's CDN. When we
 * run E2E tests with Playwright we don't want to (a) depend on real Google
 * network, (b) require a test user to sign into Google, or (c) pay for
 * Firestore writes on every CI run. Instead, Playwright intercepts every
 * request for the Firebase module URLs and serves THIS file as the
 * response — which means the app's `import { ... } from "https://..."`
 * statements get fed these stub exports instead of the real Firebase SDK.
 *
 * The stubs implement just enough of the Firebase surface to make the app
 * boot, accept a fake "sign-in" immediately, and back its Firestore
 * reads/writes with a plain in-memory Map. That's sufficient for every
 * UI-level assertion we want to make. If we ever need to test against
 * real Firestore rules we'd switch to the Firebase emulator; until then,
 * this is the simplest thing that works.
 *
 * IMPORTANT: Playwright's route handler serves the same content for each
 * of the three Firebase module URLs (app, auth, firestore). That means
 * this file must export the union of symbols the app imports from all
 * three. If the app starts importing a new Firebase function, add it
 * below or the app will throw at load time.
 */

// ---------- in-memory datastore ----------
// Keyed by collection path (string), each entry is a Map<docId, docData>.
const store = new Map();
// Per-collection-path list of active onSnapshot callbacks. When a write
// happens to a path, we notify every listener synchronously. This is a
// close-enough approximation of Firestore's real-time listener behavior
// for UI purposes.
const listeners = new Map();

const getCollection = (path) => {
    if (!store.has(path)) store.set(path, new Map());
    return store.get(path);
};
const notify = (path) => {
    const coll = getCollection(path);
    const snapshot = {
        docs: Array.from(coll.entries()).map(([id, data]) => ({
            id,
            data: () => ({ ...data }),
        })),
    };
    (listeners.get(path) || []).forEach((cb) => cb(snapshot));
};

// ---------- firebase-app ----------
export const initializeApp = () => ({ _stub: true });

// ---------- firebase-auth ----------
// The app calls `onAuthStateChanged` right after init, and only proceeds
// past the login screen when the callback fires with a truthy user. We
// fire it on a microtask so the app's listener is attached first.
export const getAuth = () => ({ _stub: true });
export const signInAnonymously = async () => ({ user: { uid: 'test-user' } });
export const signInWithCustomToken = async () => ({ user: { uid: 'test-user' } });
export const onAuthStateChanged = (_auth, cb) => {
    queueMicrotask(() =>
        cb({ uid: 'test-user', displayName: 'Test User', email: 'test@example.com' })
    );
    return () => {}; // unsubscribe noop
};
export class GoogleAuthProvider {}
export const signInWithPopup = async () => ({
    user: { uid: 'test-user', displayName: 'Test User' },
});
export const signOut = async () => {};

// ---------- firebase-firestore ----------
export const getFirestore = () => ({ _stub: true });

// In real Firestore, `collection(db, path)` returns a CollectionReference
// and `doc(db, path, id)` / `doc(collectionRef)` both work. We encode the
// path on the returned object and let `doc()` handle both call shapes.
export const collection = (_db, path) => ({ _type: 'coll', path });

export const doc = (...args) => {
    // doc(db, path, id)
    if (args.length === 3 && typeof args[1] === 'string') {
        return { _type: 'doc', path: args[1], id: args[2] };
    }
    // doc(collectionRef)  — auto-generated ID
    if (args[0] && args[0]._type === 'coll') {
        const id = 'stub-' + Math.random().toString(36).slice(2, 11);
        return { _type: 'doc', path: args[0].path, id };
    }
    // doc(db, path, id) alt form
    if (args.length >= 2) {
        return { _type: 'doc', path: args[1], id: args[2] };
    }
    throw new Error('stub doc(): unsupported argument shape');
};

export const setDoc = async (docRef, data) => {
    getCollection(docRef.path).set(docRef.id, { ...data });
    notify(docRef.path);
};

export const deleteDoc = async (docRef) => {
    getCollection(docRef.path).delete(docRef.id);
    notify(docRef.path);
};

export const query = (collRef) => collRef;

export const onSnapshot = (refOrQuery, onNext /* , onError */) => {
    const path = refOrQuery.path;
    if (!listeners.has(path)) listeners.set(path, []);
    listeners.get(path).push(onNext);
    // Fire once immediately with current state so the app renders.
    queueMicrotask(() => {
        const coll = getCollection(path);
        onNext({
            docs: Array.from(coll.entries()).map(([id, data]) => ({
                id,
                data: () => ({ ...data }),
            })),
        });
    });
    return () => {
        const arr = listeners.get(path) || [];
        const idx = arr.indexOf(onNext);
        if (idx >= 0) arr.splice(idx, 1);
    };
};

// writeBatch returns an object with set/delete and a commit() that fires
// every queued op at once. The app uses this for seeding default criteria
// and for bulk-delete.
export const writeBatch = () => {
    const ops = [];
    return {
        set: (docRef, data) => ops.push(['set', docRef, data]),
        delete: (docRef) => ops.push(['del', docRef]),
        commit: async () => {
            const touched = new Set();
            for (const [op, ref, data] of ops) {
                if (op === 'set') getCollection(ref.path).set(ref.id, { ...data });
                else getCollection(ref.path).delete(ref.id);
                touched.add(ref.path);
            }
            touched.forEach(notify);
        },
    };
};

// ---------- firebase-functions ----------
// The production app calls `httpsCallable(functions, 'aiAutofill')` to
// hit the server-side Gemini proxy. We don't want real network in tests,
// so this stub looks up the function name on `window.__functionStubs`
// and calls whatever the test spec registered there. A spec can install
// a happy-path stub that returns a fake applicant record, or an error
// stub that throws something shaped like a Firebase HttpsError (a plain
// Error whose `.message` contains the Gemini-style text our classifier
// keys off of — e.g. "requires prepayment").
//
// The returned object mirrors real httpsCallable's shape: it resolves to
// `{ data }`, which is what the app destructures.
export const getFunctions = () => ({ _stub: true });
export const httpsCallable = (_functions, name) => {
    return async (payload) => {
        const stubs = (typeof window !== 'undefined' && window.__functionStubs) || {};
        const handler = stubs[name];
        if (typeof handler !== 'function') {
            throw new Error(
                `[stub httpsCallable] no stub registered for "${name}". ` +
                `Set window.__functionStubs.${name} in your test.`
            );
        }
        const data = await handler(payload);
        return { data };
    };
};

// Expose the store on window for tests that want to inspect/reset it.
if (typeof window !== 'undefined') {
    window.__firebaseStub = { store, listeners, reset: () => { store.clear(); listeners.clear(); } };
    if (!window.__functionStubs) window.__functionStubs = {};
}
