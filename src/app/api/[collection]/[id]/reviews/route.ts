import { mutate } from '../../../../../access/editorial-http';

export async function POST(request: Request, { params }: { params: Promise<{ collection: string; id: string }> }) {
  const { collection, id } = await params;
  return mutate(request, collection, id, true);
}
