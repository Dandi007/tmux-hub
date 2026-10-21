import { test, expect } from "./emulator-fixtures";
import { defineFidelitySuite } from "./fidelity-suite";

defineFidelitySuite(test, expect);

import { defineNativeViewportFitTests } from "./native-viewport-fit";
defineNativeViewportFitTests();
