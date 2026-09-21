import { PageSkeleton } from '../../_components/page-skeleton'

export default function Loading() {
  return <PageSkeleton rows={10} stats={6} controls={true} />
}
