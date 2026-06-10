/* @refresh reload */
import { render } from "solid-js/web";
import "./themes/molv-tokens.css";
import "./themes/molv-base.css";
import App from "./App.tsx";

const root = document.getElementById("root");

render(() => <App />, root!);
