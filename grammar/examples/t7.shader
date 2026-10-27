Shader "F"
{
    SubShader
    {
        Pass
        {
            Cull Off
            ZWrite On
            Blend SrcAlpha OneMinusSrcAlpha
            Stencil
            {
                Ref 255
                Comp Always
                Pass Replace
            }
        }
    }
}
