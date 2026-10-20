import { queryOptions } from "@tanstack/react-query";

import { getCourse, getFrontDoor, getSectionPage, getStepPage } from "./-functions";

/** Everything the workshop reads sits under ["workshop"], so a finished switch or test run refreshes it in one go. */
export const courseQuery = queryOptions({ queryKey: ["workshop", "course"], queryFn: () => getCourse() });

export const frontDoorQuery = queryOptions({ queryKey: ["workshop", "front-door"], queryFn: () => getFrontDoor() });

export const stepQuery = (stepId: string) =>
  queryOptions({ queryKey: ["workshop", "step", stepId], queryFn: () => getStepPage({ data: { stepId } }) });

export const sectionQuery = (sectionId: string) =>
  queryOptions({
    queryKey: ["workshop", "section", sectionId],
    queryFn: () => getSectionPage({ data: { sectionId } }),
  });
