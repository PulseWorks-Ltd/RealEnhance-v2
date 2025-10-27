import { Route, Switch } from "wouter";
import Landing from "@/pages/landing";
import Home from "@/pages/home";
import Editor from "@/pages/Editor";
import Results from "@/pages/Results";
import { Header } from "@/components/header";
import { RequireAuth } from "@/components/RequireAuth";

export default function App() {
  return (
    <>
      <Header />
      <Switch>
        <Route path="/" component={Landing} />
        <Route path="/app">
          <RequireAuth>
            <Home />
          </RequireAuth>
        </Route>
        <Route path="/editor">
          <RequireAuth>
            <Editor />
          </RequireAuth>
        </Route>
        <Route path="/results" component={Results} />
        <Route>404 – Not Found</Route>
      </Switch>
    </>
  );
}
