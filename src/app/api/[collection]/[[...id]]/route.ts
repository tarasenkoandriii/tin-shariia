import { mutate } from '../../../../access/editorial-http';

type Context = { params: Promise<{ collection: string; id?: string[] }> };

export async function POST(request: Request, { params }: Context) {
  const { collection, id = [] } = await params;
  if (id.length > 1) return new Response(null, { status: 404 });
  return mutate(request, collection, id[0]);
}

export async function PATCH(request: Request, { params }: Context) {
  const { collection, id } = await params;
  if (id?.length !== 1) return new Response(null, { status: 404 });
  return mutate(request, collection, id[0]);
}
