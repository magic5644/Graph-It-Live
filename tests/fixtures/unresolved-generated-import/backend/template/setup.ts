// A template copied into new projects: its imports point at files of the project it is copied to.
import config from "../../vitest.config";
import seed from "./data/seed.json";

export const setup = { config, seed };
