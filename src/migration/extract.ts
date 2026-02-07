import type { ClassifiedMigration, ManualSlot } from "../types"

export function extractManualSlots(myMigrations: ClassifiedMigration[]): ManualSlot[] {
  const slots: ManualSlot[] = []

  for (let i = 0; i < myMigrations.length; i++) {
    const m = myMigrations[i]
    if (!m) continue
    if (m.classification === "manual" || m.classification === "mixed") {
      slots.push({
        originalIndex: i,
        sql: m.manualStatements,
        originalDirName: m.dirName,
        classification: m.classification,
      })
    }
  }

  return slots
}

export interface InterleaveCheck {
  safe: boolean
  problemSlot?: ManualSlot
}

export function validateSlotOrdering(myMigrations: ClassifiedMigration[]): InterleaveCheck {
  let hasGeneratedBefore = false

  for (let i = 0; i < myMigrations.length; i++) {
    const m = myMigrations[i]
    if (!m) continue

    if (m.classification === "generated") {
      hasGeneratedBefore = true
      continue
    }

    if (m.classification === "manual" || m.classification === "mixed") {
      if (!hasGeneratedBefore) continue

      const hasGeneratedAfter = myMigrations
        .slice(i + 1)
        .some((later) => later.classification === "generated")

      if (hasGeneratedAfter) {
        return {
          safe: false,
          problemSlot: {
            originalIndex: i,
            sql: m.manualStatements,
            originalDirName: m.dirName,
            classification: m.classification as "manual" | "mixed",
          },
        }
      }
    }
  }

  return { safe: true }
}
