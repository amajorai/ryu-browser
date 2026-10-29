import { z } from "zod";
import { browserWebMCPValueSchema } from "./webmcp-records.ts";

const evaluationEnvelopeSchema = z.object({ result: browserWebMCPValueSchema });
const evaluationJSONEnvelopeSchema = z.custom<
	z.output<typeof evaluationEnvelopeSchema>
>((value) => evaluationEnvelopeSchema.safeParse(value).success);
/** Preserve the HTTP result envelope's native JSON.stringify behavior for SDK values. */
export const browserEvaluationEnvelopeSchema = z.preprocess((value) => {
	if (evaluationJSONEnvelopeSchema.safeParse(value).success) {
		return value;
	}
	return JSON.parse(JSON.stringify(value));
}, evaluationJSONEnvelopeSchema);
export type BrowserEvaluationResult = z.output<
	typeof browserEvaluationEnvelopeSchema
>["result"];
